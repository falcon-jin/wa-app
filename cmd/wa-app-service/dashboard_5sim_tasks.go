package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/byte-v-forge/wa-app/internal/waapp/bff"
	"github.com/byte-v-forge/wa-app/internal/waapp/fivesim"
)

const (
	fiveSimRegistrationTaskSMSPollInterval = 5 * time.Second
	fiveSimRegistrationTaskSMSPollTimeout  = 5 * time.Minute
	fiveSimRegistrationTaskFailureDelay    = 10 * time.Second
	fiveSimRegistrationTaskMaxLogs         = 200
)

var errFiveSimRegistrationTaskInvalidInput = errors.New("invalid 5sim registration task input")

type fiveSimRegistrationTaskStatus string

const (
	fiveSimRegistrationTaskStatusRunning   fiveSimRegistrationTaskStatus = "running"
	fiveSimRegistrationTaskStatusStopping  fiveSimRegistrationTaskStatus = "stopping"
	fiveSimRegistrationTaskStatusStopped   fiveSimRegistrationTaskStatus = "stopped"
	fiveSimRegistrationTaskStatusSucceeded fiveSimRegistrationTaskStatus = "succeeded"
	fiveSimRegistrationTaskStatusFailed    fiveSimRegistrationTaskStatus = "failed"
)

type fiveSimRegistrationTaskStartInput struct {
	Country       string  `json:"country"`
	Operator      string  `json:"operator"`
	MaxPrice      float64 `json:"max_price,omitempty"`
	SuccessTarget int     `json:"success_target"`
	IntegrityMode string  `json:"integrity_mode,omitempty"`
}

type fiveSimRegistrationTaskStats struct {
	Target    int `json:"target"`
	Completed int `json:"completed"`
	Success   int `json:"success"`
	Failed    int `json:"failed"`
}

type fiveSimRegistrationTaskOrderSnapshot struct {
	ID       int64   `json:"id"`
	Phone    string  `json:"phone,omitempty"`
	Country  string  `json:"country,omitempty"`
	Operator string  `json:"operator,omitempty"`
	Product  string  `json:"product,omitempty"`
	Price    float64 `json:"price,omitempty"`
	Status   string  `json:"status,omitempty"`
	SMSCount int     `json:"sms_count"`
}

type fiveSimRegistrationTaskSnapshot struct {
	ID             string                                `json:"id"`
	Status         fiveSimRegistrationTaskStatus         `json:"status"`
	StopRequested  bool                                  `json:"stop_requested"`
	Country        string                                `json:"country"`
	Operator       string                                `json:"operator"`
	Product        string                                `json:"product"`
	MaxPrice       float64                               `json:"max_price,omitempty"`
	SuccessTarget  int                                   `json:"success_target"`
	IntegrityMode  string                                `json:"integrity_mode,omitempty"`
	Stats          fiveSimRegistrationTaskStats          `json:"stats"`
	CurrentAttempt int                                   `json:"current_attempt"`
	ActiveOrder    *fiveSimRegistrationTaskOrderSnapshot `json:"active_order,omitempty"`
	LastError      string                                `json:"last_error,omitempty"`
	FailureReasons map[string]int                        `json:"failure_reasons,omitempty"`
	Logs           []string                              `json:"logs"`
	CreatedAt      string                                `json:"created_at"`
	UpdatedAt      string                                `json:"updated_at"`
	FinishedAt     string                                `json:"finished_at,omitempty"`
}

type fiveSimRegistrationTaskDeps struct {
	RootContext context.Context
	NewID       func() string
	Now         func() time.Time
	Sleep       func(context.Context, time.Duration) error
	Run         func(context.Context, *fiveSimRegistrationTask) error
}

type fiveSimRegistrationTaskManager struct {
	mu    sync.Mutex
	deps  fiveSimRegistrationTaskDeps
	tasks map[string]*fiveSimRegistrationTask
}

type fiveSimRegistrationTask struct {
	manager        *fiveSimRegistrationTaskManager
	ID             string
	Input          fiveSimRegistrationTaskStartInput
	Status         fiveSimRegistrationTaskStatus
	StopRequested  bool
	Stats          fiveSimRegistrationTaskStats
	CurrentAttempt int
	ActiveOrder    *fiveSimRegistrationTaskOrderSnapshot
	LastError      string
	FailureReasons map[string]int
	Logs           []string
	CreatedAt      time.Time
	UpdatedAt      time.Time
	FinishedAt     time.Time
	cancel         context.CancelFunc
}

func newFiveSimRegistrationTaskManager(deps fiveSimRegistrationTaskDeps) *fiveSimRegistrationTaskManager {
	if deps.RootContext == nil {
		deps.RootContext = context.Background()
	}
	if deps.NewID == nil {
		deps.NewID = func() string { return newRequestID("wa-5sim-task") }
	}
	if deps.Now == nil {
		deps.Now = func() time.Time { return time.Now().UTC() }
	}
	if deps.Sleep == nil {
		deps.Sleep = sleepContext
	}
	return &fiveSimRegistrationTaskManager{deps: deps, tasks: map[string]*fiveSimRegistrationTask{}}
}

func (m *fiveSimRegistrationTaskManager) Start(_ context.Context, input fiveSimRegistrationTaskStartInput) (fiveSimRegistrationTaskSnapshot, error) {
	normalized, err := normalizeFiveSimRegistrationTaskStartInput(input)
	if err != nil {
		return fiveSimRegistrationTaskSnapshot{}, err
	}
	if err := m.deps.RootContext.Err(); err != nil {
		return fiveSimRegistrationTaskSnapshot{}, err
	}
	taskCtx, cancel := context.WithCancel(m.deps.RootContext)
	now := m.deps.Now()
	task := &fiveSimRegistrationTask{
		manager:        m,
		ID:             m.deps.NewID(),
		Input:          normalized,
		Status:         fiveSimRegistrationTaskStatusRunning,
		Stats:          fiveSimRegistrationTaskStats{Target: normalized.SuccessTarget},
		FailureReasons: map[string]int{},
		CreatedAt:      now,
		UpdatedAt:      now,
		cancel:         cancel,
	}
	task.appendLogLocked(now, fmt.Sprintf("启动 5sim 后台注册任务，国家 %s，渠道 %s，成功目标 %d", normalized.Country, normalized.Operator, normalized.SuccessTarget))
	m.mu.Lock()
	m.tasks[task.ID] = task
	snapshot := task.snapshotLocked()
	m.mu.Unlock()
	go m.run(taskCtx, task)
	return snapshot, nil
}

func (m *fiveSimRegistrationTaskManager) List() []fiveSimRegistrationTaskSnapshot {
	m.mu.Lock()
	defer m.mu.Unlock()
	tasks := make([]fiveSimRegistrationTaskSnapshot, 0, len(m.tasks))
	for _, task := range m.tasks {
		tasks = append(tasks, task.snapshotLocked())
	}
	sort.Slice(tasks, func(i, j int) bool {
		return tasks[i].CreatedAt > tasks[j].CreatedAt
	})
	return tasks
}

func (m *fiveSimRegistrationTaskManager) Get(taskID string) (fiveSimRegistrationTaskSnapshot, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	task, ok := m.tasks[taskID]
	if !ok {
		return fiveSimRegistrationTaskSnapshot{}, false
	}
	return task.snapshotLocked(), true
}

func (m *fiveSimRegistrationTaskManager) Stop(taskID string) (bool, error) {
	m.mu.Lock()
	task, ok := m.tasks[taskID]
	if !ok {
		m.mu.Unlock()
		return false, nil
	}
	if taskTerminal(task.Status) {
		m.mu.Unlock()
		return false, nil
	}
	now := m.deps.Now()
	task.Status = fiveSimRegistrationTaskStatusStopping
	task.StopRequested = true
	task.UpdatedAt = now
	task.appendLogLocked(now, "收到停止请求")
	cancel := task.cancel
	m.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	return true, nil
}

func (m *fiveSimRegistrationTaskManager) StopAll() int {
	m.mu.Lock()
	cancels := make([]context.CancelFunc, 0)
	now := m.deps.Now()
	for _, task := range m.tasks {
		if taskTerminal(task.Status) {
			continue
		}
		task.Status = fiveSimRegistrationTaskStatusStopping
		task.StopRequested = true
		task.UpdatedAt = now
		task.appendLogLocked(now, "收到统一停止请求")
		if task.cancel != nil {
			cancels = append(cancels, task.cancel)
		}
	}
	m.mu.Unlock()
	for _, cancel := range cancels {
		cancel()
	}
	return len(cancels)
}

func (m *fiveSimRegistrationTaskManager) run(ctx context.Context, task *fiveSimRegistrationTask) {
	run := m.deps.Run
	if run == nil {
		run = func(context.Context, *fiveSimRegistrationTask) error { return nil }
	}
	err := run(ctx, task)
	m.finish(task.ID, err)
}

func (m *fiveSimRegistrationTaskManager) finish(taskID string, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	task, ok := m.tasks[taskID]
	if !ok || taskTerminal(task.Status) {
		return
	}
	now := m.deps.Now()
	switch {
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded), task.StopRequested:
		task.Status = fiveSimRegistrationTaskStatusStopped
		task.appendLogLocked(now, "任务已停止")
	case err != nil:
		task.Status = fiveSimRegistrationTaskStatusFailed
		task.LastError = sanitizeFiveSimTaskLog(err.Error())
		task.appendLogLocked(now, "任务失败："+task.LastError)
	default:
		task.Status = fiveSimRegistrationTaskStatusSucceeded
		task.appendLogLocked(now, "任务已完成")
	}
	task.StopRequested = false
	task.ActiveOrder = nil
	task.UpdatedAt = now
	task.FinishedAt = now
}

func (t *fiveSimRegistrationTask) Log(message string) {
	t.manager.mu.Lock()
	defer t.manager.mu.Unlock()
	now := t.manager.deps.Now()
	t.UpdatedAt = now
	t.appendLogLocked(now, message)
}

func (t *fiveSimRegistrationTask) SetCurrentAttempt(attempt int) {
	t.manager.mu.Lock()
	defer t.manager.mu.Unlock()
	t.CurrentAttempt = attempt
	t.UpdatedAt = t.manager.deps.Now()
}

func (t *fiveSimRegistrationTask) SetActiveOrder(order fivesim.Order) {
	t.manager.mu.Lock()
	defer t.manager.mu.Unlock()
	t.ActiveOrder = &fiveSimRegistrationTaskOrderSnapshot{
		ID:       order.ID,
		Phone:    redactedPhone(order.Phone),
		Country:  order.Country,
		Operator: order.Operator,
		Product:  order.Product,
		Price:    order.Price,
		Status:   order.Status,
		SMSCount: order.SMSCount,
	}
	t.UpdatedAt = t.manager.deps.Now()
}

func (t *fiveSimRegistrationTask) ClearActiveOrder() {
	t.manager.mu.Lock()
	defer t.manager.mu.Unlock()
	t.ActiveOrder = nil
	t.UpdatedAt = t.manager.deps.Now()
}

func (t *fiveSimRegistrationTask) IncrementCompleted(result string) {
	t.manager.mu.Lock()
	defer t.manager.mu.Unlock()
	t.Stats.Completed++
	switch result {
	case "success":
		t.Stats.Success++
	case "failed":
		t.Stats.Failed++
	}
	t.UpdatedAt = t.manager.deps.Now()
}

func (t *fiveSimRegistrationTask) RecordFailure(reason string, err error) {
	t.manager.mu.Lock()
	defer t.manager.mu.Unlock()
	if t.FailureReasons == nil {
		t.FailureReasons = map[string]int{}
	}
	t.FailureReasons[reason]++
	t.LastError = sanitizeFiveSimTaskLog(err.Error())
	now := t.manager.deps.Now()
	t.UpdatedAt = now
	t.appendLogLocked(now, "失败："+t.LastError)
}

func (t *fiveSimRegistrationTask) appendLogLocked(now time.Time, message string) {
	t.Logs = append(t.Logs, fmt.Sprintf("%s %s", now.Format("15:04:05"), sanitizeFiveSimTaskLog(message)))
	if len(t.Logs) > fiveSimRegistrationTaskMaxLogs {
		t.Logs = append([]string(nil), t.Logs[len(t.Logs)-fiveSimRegistrationTaskMaxLogs:]...)
	}
}

func (t *fiveSimRegistrationTask) snapshotLocked() fiveSimRegistrationTaskSnapshot {
	failures := make(map[string]int, len(t.FailureReasons))
	for key, count := range t.FailureReasons {
		failures[key] = count
	}
	var active *fiveSimRegistrationTaskOrderSnapshot
	if t.ActiveOrder != nil {
		copied := *t.ActiveOrder
		active = &copied
	}
	snapshot := fiveSimRegistrationTaskSnapshot{
		ID:             t.ID,
		Status:         t.Status,
		StopRequested:  t.StopRequested,
		Country:        t.Input.Country,
		Operator:       t.Input.Operator,
		Product:        fivesim.Product,
		MaxPrice:       t.Input.MaxPrice,
		SuccessTarget:  t.Input.SuccessTarget,
		IntegrityMode:  t.Input.IntegrityMode,
		Stats:          t.Stats,
		CurrentAttempt: t.CurrentAttempt,
		ActiveOrder:    active,
		LastError:      t.LastError,
		FailureReasons: failures,
		Logs:           append([]string(nil), t.Logs...),
		CreatedAt:      t.CreatedAt.Format(time.RFC3339),
		UpdatedAt:      t.UpdatedAt.Format(time.RFC3339),
	}
	if t.FinishedAt.IsZero() {
		return snapshot
	}
	snapshot.FinishedAt = t.FinishedAt.Format(time.RFC3339)
	return snapshot
}

func normalizeFiveSimRegistrationTaskStartInput(input fiveSimRegistrationTaskStartInput) (fiveSimRegistrationTaskStartInput, error) {
	input.Country = strings.TrimSpace(input.Country)
	input.Operator = strings.TrimSpace(input.Operator)
	input.IntegrityMode = strings.TrimSpace(input.IntegrityMode)
	if input.Country == "" || input.Operator == "" {
		return fiveSimRegistrationTaskStartInput{}, errFiveSimRegistrationTaskInvalidInput
	}
	if input.SuccessTarget <= 0 {
		input.SuccessTarget = 1
	}
	if input.SuccessTarget > 100 {
		input.SuccessTarget = 100
	}
	if input.MaxPrice < 0 {
		input.MaxPrice = 0
	}
	return input, nil
}

func taskTerminal(status fiveSimRegistrationTaskStatus) bool {
	switch status {
	case fiveSimRegistrationTaskStatusStopped, fiveSimRegistrationTaskStatusSucceeded, fiveSimRegistrationTaskStatusFailed:
		return true
	default:
		return false
	}
}

func sleepContext(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func sanitizeFiveSimTaskLog(message string) string {
	return fivesim.SanitizeAPIError(message)
}

func (s *dashboardHTTP) newFiveSimRegistrationTaskManager(ctx context.Context) *fiveSimRegistrationTaskManager {
	return newFiveSimRegistrationTaskManager(fiveSimRegistrationTaskDeps{
		RootContext: ctx,
		Run: func(taskCtx context.Context, task *fiveSimRegistrationTask) error {
			return s.runFiveSimRegistrationTask(taskCtx, task)
		},
	})
}

func (s *dashboardHTTP) handleFiveSimRegistrationTasks(w http.ResponseWriter, r *http.Request) {
	manager := s.requireFiveSimRegistrationTaskManager()
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, map[string]any{"tasks": manager.List()})
	case http.MethodPost:
		if s.service == nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "wa-app service is not configured"})
			return
		}
		if !s.fiveSimClient().Configured() {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "5sim token is not configured"})
			return
		}
		payload, ok := readJSONPayload(w, r)
		if !ok {
			return
		}
		input := fiveSimRegistrationTaskStartInput{
			Country:       strings.TrimSpace(textField(payload, "country")),
			Operator:      strings.TrimSpace(textField(payload, "operator")),
			MaxPrice:      floatField(payload, "max_price"),
			SuccessTarget: positiveInt(firstNonEmpty(textField(payload, "success_target"), textField(payload, "target")), 1),
			IntegrityMode: strings.TrimSpace(textField(payload, "integrity_mode")),
		}
		task, err := manager.Start(context.Background(), input)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusAccepted, map[string]any{"task": task})
	default:
		methodNotAllowed(w, http.MethodGet+", "+http.MethodPost)
	}
}

func (s *dashboardHTTP) handleFiveSimRegistrationTaskResource(w http.ResponseWriter, r *http.Request) {
	taskID, action, ok := parseFiveSimRegistrationTaskPath(r.URL.Path)
	if !ok {
		http.NotFound(w, r)
		return
	}
	manager := s.requireFiveSimRegistrationTaskManager()
	if taskID == "stop" && action == "" {
		if r.Method != http.MethodPost {
			methodNotAllowed(w, http.MethodPost)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"stopped_count": manager.StopAll(), "tasks": manager.List()})
		return
	}
	switch action {
	case "":
		if r.Method != http.MethodGet {
			methodNotAllowed(w, http.MethodGet)
			return
		}
		task, ok := manager.Get(taskID)
		if !ok {
			http.NotFound(w, r)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"task": task})
	case "stop":
		if r.Method != http.MethodPost {
			methodNotAllowed(w, http.MethodPost)
			return
		}
		stopped, err := manager.Stop(taskID)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		task, ok := manager.Get(taskID)
		if !ok {
			http.NotFound(w, r)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"stopped": stopped, "task": task})
	default:
		http.NotFound(w, r)
	}
}

func (s *dashboardHTTP) requireFiveSimRegistrationTaskManager() *fiveSimRegistrationTaskManager {
	if s.fiveSimTasks == nil {
		s.fiveSimTasks = s.newFiveSimRegistrationTaskManager(context.Background())
	}
	return s.fiveSimTasks
}

func parseFiveSimRegistrationTaskPath(path string) (string, string, bool) {
	value := strings.Trim(strings.TrimPrefix(path, "/api/wa/debug/5sim/registration-tasks/"), "/")
	if value == "" {
		return "", "", false
	}
	parts := strings.Split(value, "/")
	if len(parts) > 2 {
		return "", "", false
	}
	rawID, err := url.PathUnescape(parts[0])
	if err != nil || strings.TrimSpace(rawID) == "" {
		return "", "", false
	}
	action := ""
	if len(parts) == 2 {
		action = parts[1]
	}
	return strings.TrimSpace(rawID), action, true
}

func (s *dashboardHTTP) runFiveSimRegistrationTask(ctx context.Context, task *fiveSimRegistrationTask) error {
	if s.service == nil {
		return errors.New("wa-app service is not configured")
	}
	client := s.fiveSimClient()
	if !client.Configured() {
		return errors.New("5sim token is not configured")
	}
	successCount := 0
	for attempt := 1; successCount < task.Input.SuccessTarget; attempt++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		task.SetCurrentAttempt(attempt)
		result, err := s.runFiveSimRegistrationTaskAttempt(ctx, client, task, attempt)
		if result == "success" {
			successCount++
			continue
		}
		if err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		task.Log("等待 10 秒后开始下一轮注册")
		if err := s.fiveSimTaskSleep(ctx, fiveSimRegistrationTaskFailureDelay); err != nil {
			return err
		}
	}
	return nil
}

func (s *dashboardHTTP) runFiveSimRegistrationTaskAttempt(ctx context.Context, client *fivesim.Client, task *fiveSimRegistrationTask, attempt int) (string, error) {
	var order fivesim.Order
	finished := false
	task.Log(fmt.Sprintf("第 %d 轮：校验 5sim 库存", attempt))
	inventory, err := client.FetchWhatsAppInventory(ctx)
	if err != nil {
		return s.recordFiveSimTaskAttemptFailure(ctx, client, task, attempt, order, finished, err)
	}
	if err := fivesim.ValidateBuyRequest(fivesim.BuyRequest{Country: task.Input.Country, Operator: task.Input.Operator, MaxPrice: task.Input.MaxPrice, Inventory: inventory}); err != nil {
		return s.recordFiveSimTaskAttemptFailure(ctx, client, task, attempt, order, finished, err)
	}
	task.Log(fmt.Sprintf("第 %d 轮：购买 5sim 号码", attempt))
	order, err = client.BuyActivation(ctx, task.Input.Country, task.Input.Operator)
	if err != nil {
		return s.recordFiveSimTaskAttemptFailure(ctx, client, task, attempt, order, finished, err)
	}
	task.SetActiveOrder(order)
	task.Log(fmt.Sprintf("第 %d 轮：订单 %d 已创建", attempt, order.ID))
	phone, ok := parseFiveSimPhone(order.Phone)
	if !ok {
		return s.recordFiveSimTaskAttemptFailure(ctx, client, task, attempt, order, finished, errors.New("5sim order did not return usable phone"))
	}
	if err := ctx.Err(); err != nil {
		return s.recordFiveSimTaskAttemptFailure(ctx, client, task, attempt, order, finished, err)
	}
	task.Log(fmt.Sprintf("第 %d 轮：请求 WA 验证码", attempt))
	registration, err := bff.StartRegistration(s.service, ctx, fiveSimRegistrationPayload(phone, task.Input.IntegrityMode))
	if err != nil {
		return s.recordFiveSimTaskAttemptFailure(ctx, client, task, attempt, order, finished, err)
	}
	if message := fiveSimTaskWorkflowFailureMessage(registration); message != "" {
		return s.recordFiveSimTaskAttemptFailure(ctx, client, task, attempt, order, finished, errors.New(message))
	}
	accountID := textField(registration, "wa_account_id")
	verificationRequestID := textField(registration, "verification_request_id")
	if accountID == "" || verificationRequestID == "" {
		return s.recordFiveSimTaskAttemptFailure(ctx, client, task, attempt, order, finished, errors.New("WA registration did not return account id or verification request id"))
	}
	checked, err := s.waitFiveSimTaskSMS(ctx, client, task, order.ID, attempt)
	if err != nil {
		return s.recordFiveSimTaskAttemptFailure(ctx, client, task, attempt, order, finished, err)
	}
	task.Log(fmt.Sprintf("第 %d 轮：提交 OTP", attempt))
	submitResult, err := bff.ResumeRegistrationOTP(s.service, ctx, fiveSimRegistrationOTPPayload(accountID, verificationRequestID, checked.SMSCode, task.Input.IntegrityMode))
	if err != nil {
		return s.recordFiveSimTaskAttemptFailure(ctx, client, task, attempt, order, finished, err)
	}
	if message := fiveSimTaskWorkflowFailureMessage(submitResult); message != "" {
		return s.recordFiveSimTaskAttemptFailure(ctx, client, task, attempt, order, finished, errors.New(message))
	}
	task.Log(fmt.Sprintf("第 %d 轮：完成 5sim 订单", attempt))
	order, err = client.FinishOrder(ctx, order.ID)
	if err != nil {
		return s.recordFiveSimTaskAttemptFailure(ctx, client, task, attempt, order, finished, err)
	}
	finished = true
	task.SetActiveOrder(order)
	task.IncrementCompleted("success")
	task.Log(fmt.Sprintf("第 %d 轮：注册成功", attempt))
	task.ClearActiveOrder()
	return "success", nil
}

func (s *dashboardHTTP) waitFiveSimTaskSMS(ctx context.Context, client *fivesim.Client, task *fiveSimRegistrationTask, orderID int64, attempt int) (fivesim.Order, error) {
	deadline := time.Now().Add(fiveSimRegistrationTaskSMSPollTimeout)
	pollCount := 1
	for time.Now().Before(deadline) {
		if err := ctx.Err(); err != nil {
			return fivesim.Order{}, err
		}
		remaining := int(time.Until(deadline).Seconds())
		if remaining < 0 {
			remaining = 0
		}
		task.Log(fmt.Sprintf("第 %d 轮：等待短信，剩余 %ds，第 %d 次查询", attempt, remaining, pollCount))
		order, err := client.CheckOrder(ctx, orderID)
		if err != nil {
			return fivesim.Order{}, err
		}
		task.SetActiveOrder(order)
		if strings.TrimSpace(order.SMSCode) != "" {
			task.Log(fmt.Sprintf("第 %d 轮：已收到短信，准备提交 OTP", attempt))
			return order, nil
		}
		task.Log(fmt.Sprintf("第 %d 轮：暂未收到短信，订单状态 %s，短信数 %d", attempt, firstNonEmpty(order.Status, "-"), order.SMSCount))
		pollCount++
		wait := fiveSimRegistrationTaskSMSPollInterval
		if until := time.Until(deadline); until < wait {
			wait = until
		}
		if wait <= 0 {
			break
		}
		if err := s.fiveSimTaskSleep(ctx, wait); err != nil {
			return fivesim.Order{}, err
		}
	}
	return fivesim.Order{}, errors.New("OTP_TIMEOUT")
}

func (s *dashboardHTTP) recordFiveSimTaskAttemptFailure(ctx context.Context, client *fivesim.Client, task *fiveSimRegistrationTask, attempt int, order fivesim.Order, finished bool, err error) (string, error) {
	if err == nil {
		err = errors.New("attempt failed")
	}
	reason := fiveSimTaskFailureReason(err.Error())
	task.RecordFailure(reason, err)
	task.Log(fmt.Sprintf("第 %d 轮失败：%s", attempt, reason))
	if order.ID > 0 && !finished {
		action := fiveSimTaskFailureAction(err.Error())
		closeCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		var closeErr error
		if action == "ban" {
			task.Log(fmt.Sprintf("上报 5sim 坏号 %d", order.ID))
			order, closeErr = client.BanOrder(closeCtx, order.ID)
		} else {
			task.Log(fmt.Sprintf("取消 5sim 订单 %d", order.ID))
			order, closeErr = client.CancelOrder(closeCtx, order.ID)
		}
		if closeErr != nil {
			task.RecordFailure(strings.ToUpper(action)+"_FAILED", closeErr)
		} else {
			task.SetActiveOrder(order)
		}
	}
	task.IncrementCompleted("failed")
	task.ClearActiveOrder()
	if ctxErr := ctx.Err(); ctxErr != nil {
		return "failed", ctxErr
	}
	return "failed", nil
}

func (s *dashboardHTTP) fiveSimTaskSleep(ctx context.Context, duration time.Duration) error {
	if s.fiveSimTasks == nil {
		return sleepContext(ctx, duration)
	}
	return s.fiveSimTasks.deps.Sleep(ctx, duration)
}

func fiveSimRegistrationPayload(phone fiveSimPhoneTarget, integrityMode string) map[string]any {
	payload := map[string]any{
		"region":               phone.Region,
		"phone":                phone.Phone,
		"e164_number":          phone.E164Number,
		"country_calling_code": phone.CountryCallingCode,
		"country_iso2":         phone.CountryISO2,
		"delivery_method":      "sms",
	}
	if strings.TrimSpace(integrityMode) != "" {
		payload["integrity_mode"] = strings.TrimSpace(integrityMode)
	}
	return payload
}

func fiveSimRegistrationOTPPayload(accountID string, verificationRequestID string, code string, integrityMode string) map[string]any {
	payload := map[string]any{
		"wa_account_id":           accountID,
		"verification_request_id": verificationRequestID,
		"otp":                     code,
	}
	if strings.TrimSpace(integrityMode) != "" {
		payload["integrity_mode"] = strings.TrimSpace(integrityMode)
	}
	return payload
}

func fiveSimTaskWorkflowFailureMessage(result map[string]any) string {
	if len(result) == 0 {
		return "empty WA workflow response"
	}
	if value, ok := result["success"].(bool); ok && !value {
		return firstNonEmpty(textField(result, "error_message"), textField(result, "reject_reason"), textField(result, "status"), "WA workflow failed")
	}
	if message := firstNonEmpty(textField(result, "error_message"), textField(result, "reject_reason")); message != "" {
		return message
	}
	return ""
}

func fiveSimTaskFailureReason(message string) string {
	normalized := strings.ToLower(message)
	switch {
	case strings.Contains(normalized, "blocked"), strings.Contains(normalized, "banned"), strings.Contains(normalized, "reject"), strings.Contains(message, "封禁"), strings.Contains(message, "封号"), strings.Contains(message, "拒绝"):
		return "NUMBER_REJECTED_OR_BLOCKED"
	case strings.Contains(message, "OTP_TIMEOUT"):
		return "OTP_TIMEOUT"
	case strings.Contains(normalized, "price"), strings.Contains(message, "价格"):
		return "PRICE_LIMIT"
	case strings.Contains(normalized, "inventory"), strings.Contains(message, "库存"):
		return "NO_INVENTORY"
	default:
		return "FAILED"
	}
}

func fiveSimTaskFailureAction(message string) string {
	if fiveSimTaskFailureReason(message) == "NUMBER_REJECTED_OR_BLOCKED" {
		return "ban"
	}
	return "cancel"
}
