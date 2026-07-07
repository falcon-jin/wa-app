package fivesim

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	DefaultBaseURL = "https://5sim.net"
	Product        = "whatsapp"
)

type Client struct {
	baseURL    string
	token      string
	httpClient *http.Client
}

type InventoryItem struct {
	Country  string   `json:"country"`
	Operator string   `json:"operator"`
	Cost     float64  `json:"cost"`
	Count    int      `json:"count"`
	Rate     *float64 `json:"rate,omitempty"`
}

type Order struct {
	ID       int64   `json:"id"`
	Phone    string  `json:"phone"`
	Country  string  `json:"country,omitempty"`
	Operator string  `json:"operator,omitempty"`
	Product  string  `json:"product,omitempty"`
	Price    float64 `json:"price,omitempty"`
	Status   string  `json:"status,omitempty"`
	Expires  string  `json:"expires,omitempty"`
	SMSCode  string  `json:"sms_code,omitempty"`
	SMSCount int     `json:"sms_count"`
}

type BuyRequest struct {
	Country   string
	Operator  string
	MaxPrice  float64
	Inventory []InventoryItem
}

func NewClient(token string, baseURL string, httpClient *http.Client) *Client {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 20 * time.Second}
	}
	return &Client{
		baseURL:    strings.TrimRight(firstNonEmpty(baseURL, DefaultBaseURL), "/"),
		token:      strings.TrimSpace(token),
		httpClient: httpClient,
	}
}

func (c *Client) Configured() bool {
	return strings.TrimSpace(c.token) != ""
}

func (c *Client) FetchWhatsAppInventory(ctx context.Context) ([]InventoryItem, error) {
	endpoint := c.baseURL + "/v1/guest/prices?product=" + url.QueryEscape(Product)
	body, err := c.do(ctx, http.MethodGet, endpoint, false)
	if err != nil {
		return nil, err
	}
	return NormalizeWhatsAppInventory(body)
}

func (c *Client) BuyActivation(ctx context.Context, country string, operator string) (Order, error) {
	if err := requireToken(c.token); err != nil {
		return Order{}, err
	}
	endpoint := fmt.Sprintf("%s/v1/user/buy/activation/%s/%s/%s", c.baseURL, url.PathEscape(country), url.PathEscape(operator), Product)
	body, err := c.do(ctx, http.MethodGet, endpoint, true)
	if err != nil {
		return Order{}, err
	}
	return DecodeOrder(body)
}

func (c *Client) CheckOrder(ctx context.Context, id int64) (Order, error) {
	if err := requireToken(c.token); err != nil {
		return Order{}, err
	}
	body, err := c.do(ctx, http.MethodGet, fmt.Sprintf("%s/v1/user/check/%d", c.baseURL, id), true)
	if err != nil {
		return Order{}, err
	}
	return DecodeOrder(body)
}

func (c *Client) FinishOrder(ctx context.Context, id int64) (Order, error) {
	return c.orderAction(ctx, "finish", id)
}

func (c *Client) CancelOrder(ctx context.Context, id int64) (Order, error) {
	return c.orderAction(ctx, "cancel", id)
}

func (c *Client) BanOrder(ctx context.Context, id int64) (Order, error) {
	return c.orderAction(ctx, "ban", id)
}

func (c *Client) orderAction(ctx context.Context, action string, id int64) (Order, error) {
	if err := requireToken(c.token); err != nil {
		return Order{}, err
	}
	body, err := c.do(ctx, http.MethodGet, fmt.Sprintf("%s/v1/user/%s/%d", c.baseURL, action, id), true)
	if err != nil {
		return Order{}, err
	}
	order, err := DecodeOrder(body)
	if err != nil {
		order.ID = id
		return order, nil
	}
	return order, nil
}

func (c *Client) do(ctx context.Context, method string, endpoint string, auth bool) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, method, endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	if auth {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("5sim request failed: %s", SanitizeAPIError(err.Error()))
	}
	defer resp.Body.Close()
	body, readErr := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if readErr != nil {
		return nil, fmt.Errorf("5sim response read failed")
	}
	body = bytes.TrimSpace(body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		message := string(body)
		if message == "" {
			message = resp.Status
		}
		return nil, fmt.Errorf("5sim request failed: %s", SanitizeAPIError(message))
	}
	return body, nil
}

func NormalizeWhatsAppInventory(raw []byte) ([]InventoryItem, error) {
	var root map[string]any
	if err := decodeJSON(raw, &root); err != nil {
		return nil, err
	}
	productRoot := objectMap(root[Product])
	if productRoot == nil {
		productRoot = root
	}
	items := make([]InventoryItem, 0)
	for country, value := range productRoot {
		operatorRoot := objectMap(value)
		if operatorRoot == nil {
			continue
		}
		if nestedProduct := objectMap(operatorRoot[Product]); nestedProduct != nil {
			operatorRoot = nestedProduct
		}
		for operator, rawPrice := range operatorRoot {
			price := objectMap(rawPrice)
			if price == nil {
				continue
			}
			item := InventoryItem{
				Country:  country,
				Operator: operator,
				Cost:     numberField(price, "cost"),
				Count:    int(numberField(price, "count")),
			}
			if rate, ok := optionalNumberField(price, "rate"); ok {
				item.Rate = &rate
			}
			items = append(items, item)
		}
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].Country == items[j].Country {
			return items[i].Operator < items[j].Operator
		}
		return items[i].Country < items[j].Country
	})
	return items, nil
}

func DecodeOrder(raw []byte) (Order, error) {
	var payload struct {
		ID       json.Number `json:"id"`
		Phone    string      `json:"phone"`
		Country  string      `json:"country"`
		Operator string      `json:"operator"`
		Product  string      `json:"product"`
		Price    json.Number `json:"price"`
		Status   string      `json:"status"`
		Expires  string      `json:"expires"`
		SMS      []struct {
			Code string `json:"code"`
			Text string `json:"text"`
		} `json:"sms"`
	}
	if err := decodeJSON(raw, &payload); err != nil {
		return Order{}, err
	}
	id, _ := payload.ID.Int64()
	price, _ := payload.Price.Float64()
	order := Order{
		ID:       id,
		Phone:    strings.TrimSpace(payload.Phone),
		Country:  strings.TrimSpace(payload.Country),
		Operator: strings.TrimSpace(payload.Operator),
		Product:  strings.TrimSpace(payload.Product),
		Price:    price,
		Status:   strings.TrimSpace(payload.Status),
		Expires:  strings.TrimSpace(payload.Expires),
		SMSCount: len(payload.SMS),
	}
	for _, sms := range payload.SMS {
		code := strings.TrimSpace(sms.Code)
		if code == "" {
			code = extractOTP(sms.Text)
		}
		if code != "" {
			order.SMSCode = code
			break
		}
	}
	return order, nil
}

func ValidateBuyRequest(req BuyRequest) error {
	country := strings.TrimSpace(req.Country)
	operator := strings.TrimSpace(req.Operator)
	if country == "" {
		return errors.New("5sim country is required")
	}
	if operator == "" {
		return errors.New("5sim operator is required")
	}
	for _, item := range req.Inventory {
		if item.Country != country || item.Operator != operator {
			continue
		}
		if item.Count <= 0 {
			return errors.New("selected 5sim inventory is empty")
		}
		if req.MaxPrice > 0 && item.Cost > req.MaxPrice {
			return fmt.Errorf("selected 5sim price %s exceeds max price %s", trimFloat(item.Cost), trimFloat(req.MaxPrice))
		}
		return nil
	}
	return errors.New("selected 5sim inventory not found")
}

func SanitizeAPIError(message string) string {
	value := strings.TrimSpace(message)
	if value == "" {
		return "5sim request failed"
	}
	for _, pattern := range []*regexp.Regexp{
		regexp.MustCompile(`(?i)Bearer\s+[A-Za-z0-9._~+/=-]+`),
		regexp.MustCompile(`\+\d{6,15}`),
		regexp.MustCompile(`\b\d{6}\b`),
	} {
		value = pattern.ReplaceAllStringFunc(value, func(match string) string {
			if strings.HasPrefix(strings.ToLower(match), "bearer") {
				return "Bearer ***"
			}
			if strings.HasPrefix(match, "+") {
				return "+***"
			}
			return "***"
		})
	}
	return value
}

func requireToken(token string) error {
	if strings.TrimSpace(token) == "" {
		return errors.New("5sim token is not configured")
	}
	return nil
}

var otpPattern = regexp.MustCompile(`\b\d{4,8}\b`)

func extractOTP(text string) string {
	return otpPattern.FindString(text)
}

func decodeJSON(raw []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("decode 5sim response failed")
	}
	return nil
}

func objectMap(value any) map[string]any {
	if typed, ok := value.(map[string]any); ok {
		return typed
	}
	return nil
}

func numberField(data map[string]any, key string) float64 {
	value, _ := optionalNumberField(data, key)
	return value
}

func optionalNumberField(data map[string]any, key string) (float64, bool) {
	switch value := data[key].(type) {
	case json.Number:
		parsed, err := value.Float64()
		return parsed, err == nil
	case float64:
		return value, true
	case int:
		return float64(value), true
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
		return parsed, err == nil
	default:
		return 0, false
	}
}

func trimFloat(value float64) string {
	return strconv.FormatFloat(value, 'f', -1, 64)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
