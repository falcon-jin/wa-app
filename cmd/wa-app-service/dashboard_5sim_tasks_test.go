package main

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestFiveSimRegistrationTaskManagerKeepsFinishedTasksVisible(t *testing.T) {
	manager := newFiveSimRegistrationTaskManager(fiveSimRegistrationTaskDeps{
		NewID: func() string { return "task-success" },
		Run: func(ctx context.Context, task *fiveSimRegistrationTask) error {
			task.Log("finished")
			task.IncrementCompleted("success")
			return nil
		},
	})

	task, err := manager.Start(context.Background(), fiveSimRegistrationTaskStartInput{Country: "england", Operator: "virtual34", SuccessTarget: 1})
	if err != nil {
		t.Fatalf("Start returned error: %v", err)
	}
	waitForTaskStatus(t, manager, task.ID, fiveSimRegistrationTaskStatusSucceeded)

	tasks := manager.List()
	if len(tasks) != 1 {
		t.Fatalf("List returned %d tasks, want 1", len(tasks))
	}
	if tasks[0].ID != "task-success" {
		t.Fatalf("task id = %q, want task-success", tasks[0].ID)
	}
	if tasks[0].Stats.Success != 1 {
		t.Fatalf("success count = %d, want 1", tasks[0].Stats.Success)
	}
	if len(tasks[0].Logs) == 0 {
		t.Fatal("finished task logs were not retained")
	}
}

func TestFiveSimRegistrationTaskManagerStopsOneOrAllRunningTasks(t *testing.T) {
	blocked := make(chan struct{})
	release := make(chan struct{})
	ids := []string{"task-1", "task-2"}
	manager := newFiveSimRegistrationTaskManager(fiveSimRegistrationTaskDeps{
		NewID: func() string {
			id := ids[0]
			ids = ids[1:]
			return id
		},
		Run: func(ctx context.Context, task *fiveSimRegistrationTask) error {
			blocked <- struct{}{}
			select {
			case <-ctx.Done():
				task.Log("cancelled")
				return ctx.Err()
			case <-release:
				task.Log("released")
				return nil
			}
		},
	})

	first, err := manager.Start(context.Background(), fiveSimRegistrationTaskStartInput{Country: "england", Operator: "virtual34", SuccessTarget: 1})
	if err != nil {
		t.Fatalf("Start first returned error: %v", err)
	}
	second, err := manager.Start(context.Background(), fiveSimRegistrationTaskStartInput{Country: "england", Operator: "virtual35", SuccessTarget: 1})
	if err != nil {
		t.Fatalf("Start second returned error: %v", err)
	}
	waitForBlockedRuns(t, blocked, 2)

	stopped, err := manager.Stop(first.ID)
	if err != nil {
		t.Fatalf("Stop returned error: %v", err)
	}
	if !stopped {
		t.Fatal("Stop returned false, want true")
	}
	waitForTaskStatus(t, manager, first.ID, fiveSimRegistrationTaskStatusStopped)
	if got := mustTask(t, manager, second.ID).Status; got != fiveSimRegistrationTaskStatusRunning {
		t.Fatalf("second task status = %s, want running", got)
	}

	count := manager.StopAll()
	if count != 1 {
		t.Fatalf("StopAll stopped %d tasks, want 1", count)
	}
	waitForTaskStatus(t, manager, second.ID, fiveSimRegistrationTaskStatusStopped)
	close(release)
}

func waitForBlockedRuns(t *testing.T, blocked <-chan struct{}, count int) {
	t.Helper()
	timeout := time.After(2 * time.Second)
	for i := 0; i < count; i++ {
		select {
		case <-blocked:
		case <-timeout:
			t.Fatalf("timed out waiting for run %d", i+1)
		}
	}
}

func waitForTaskStatus(t *testing.T, manager *fiveSimRegistrationTaskManager, taskID string, want fiveSimRegistrationTaskStatus) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		task := mustTask(t, manager, taskID)
		if task.Status == want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	task := mustTask(t, manager, taskID)
	t.Fatalf("task %s status = %s, want %s", taskID, task.Status, want)
}

func mustTask(t *testing.T, manager *fiveSimRegistrationTaskManager, taskID string) fiveSimRegistrationTaskSnapshot {
	t.Helper()
	task, ok := manager.Get(taskID)
	if !ok {
		t.Fatalf("task %s not found", taskID)
	}
	return task
}

func TestFiveSimRegistrationTaskManagerRejectsInvalidStartInput(t *testing.T) {
	manager := newFiveSimRegistrationTaskManager(fiveSimRegistrationTaskDeps{})
	_, err := manager.Start(context.Background(), fiveSimRegistrationTaskStartInput{})
	if !errors.Is(err, errFiveSimRegistrationTaskInvalidInput) {
		t.Fatalf("Start error = %v, want invalid input", err)
	}
}
