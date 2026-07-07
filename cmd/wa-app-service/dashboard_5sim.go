package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/byte-v-forge/wa-app/internal/waapp/fivesim"
	"github.com/nyaruka/phonenumbers"
)

type dashboardFiveSimConfig struct {
	Token      string
	APIBaseURL string
}

type fiveSimPhoneTarget struct {
	Region             string `json:"region"`
	Phone              string `json:"phone"`
	E164Number         string `json:"e164_number"`
	CountryCallingCode string `json:"country_calling_code"`
	CountryISO2        string `json:"country_iso2"`
}

type fiveSimOrderDTO struct {
	ID          int64               `json:"id"`
	Phone       string              `json:"phone"`
	Country     string              `json:"country,omitempty"`
	Operator    string              `json:"operator,omitempty"`
	Product     string              `json:"product,omitempty"`
	Price       float64             `json:"price,omitempty"`
	Status      string              `json:"status,omitempty"`
	Expires     string              `json:"expires,omitempty"`
	SMSCode     string              `json:"sms_code,omitempty"`
	SMSCount    int                 `json:"sms_count"`
	PhoneTarget *fiveSimPhoneTarget `json:"phone_target,omitempty"`
}

func (s *dashboardHTTP) fiveSimClient() *fivesim.Client {
	return fivesim.NewClient(s.fiveSim.Token, s.fiveSim.APIBaseURL, nil)
}

func (s *dashboardHTTP) handleFiveSimStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"configured": strings.TrimSpace(s.fiveSim.Token) != "",
		"product":    fivesim.Product,
	})
}

func (s *dashboardHTTP) handleFiveSimWhatsAppInventory(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	items, err := s.fiveSimClient().FetchWhatsAppInventory(ctx)
	if err != nil {
		writeFiveSimError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (s *dashboardHTTP) handleFiveSimOrders(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	client := s.fiveSimClient()
	if !client.Configured() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "5sim token is not configured"})
		return
	}
	payload, ok := readJSONPayload(w, r)
	if !ok {
		return
	}
	country := strings.TrimSpace(textField(payload, "country"))
	operator := strings.TrimSpace(textField(payload, "operator"))
	maxPrice := floatField(payload, "max_price")

	ctx, cancel := context.WithTimeout(r.Context(), 35*time.Second)
	defer cancel()
	inventory, err := client.FetchWhatsAppInventory(ctx)
	if err != nil {
		writeFiveSimError(w, http.StatusBadGateway, err)
		return
	}
	if err := fivesim.ValidateBuyRequest(fivesim.BuyRequest{Country: country, Operator: operator, MaxPrice: maxPrice, Inventory: inventory}); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	order, err := client.BuyActivation(ctx, country, operator)
	if err != nil {
		writeFiveSimError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, fiveSimOrderResponse(order))
}

func (s *dashboardHTTP) handleFiveSimOrderResource(w http.ResponseWriter, r *http.Request) {
	orderID, action, ok := parseFiveSimOrderPath(r.URL.Path)
	if !ok {
		http.NotFound(w, r)
		return
	}
	client := s.fiveSimClient()
	if !client.Configured() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "5sim token is not configured"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	var (
		order fivesim.Order
		err   error
	)
	switch action {
	case "":
		if r.Method != http.MethodGet {
			methodNotAllowed(w, http.MethodGet)
			return
		}
		order, err = client.CheckOrder(ctx, orderID)
	case "finish":
		if r.Method != http.MethodPost {
			methodNotAllowed(w, http.MethodPost)
			return
		}
		order, err = client.FinishOrder(ctx, orderID)
	case "cancel":
		if r.Method != http.MethodPost {
			methodNotAllowed(w, http.MethodPost)
			return
		}
		order, err = client.CancelOrder(ctx, orderID)
	case "ban":
		if r.Method != http.MethodPost {
			methodNotAllowed(w, http.MethodPost)
			return
		}
		order, err = client.BanOrder(ctx, orderID)
	default:
		http.NotFound(w, r)
		return
	}
	if err != nil {
		writeFiveSimError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, fiveSimOrderResponse(order))
}

func parseFiveSimOrderPath(path string) (int64, string, bool) {
	value := strings.Trim(strings.TrimPrefix(path, "/api/wa/debug/5sim/orders/"), "/")
	if value == "" {
		return 0, "", false
	}
	parts := strings.Split(value, "/")
	if len(parts) > 2 {
		return 0, "", false
	}
	rawID, err := url.PathUnescape(parts[0])
	if err != nil {
		return 0, "", false
	}
	id, err := strconv.ParseInt(rawID, 10, 64)
	if err != nil || id <= 0 {
		return 0, "", false
	}
	action := ""
	if len(parts) == 2 {
		action = parts[1]
	}
	return id, action, true
}

func fiveSimOrderResponse(order fivesim.Order) fiveSimOrderDTO {
	dto := fiveSimOrderDTO{
		ID:       order.ID,
		Phone:    redactedPhone(order.Phone),
		Country:  order.Country,
		Operator: order.Operator,
		Product:  order.Product,
		Price:    order.Price,
		Status:   order.Status,
		Expires:  order.Expires,
		SMSCode:  order.SMSCode,
		SMSCount: order.SMSCount,
	}
	if phone, ok := parseFiveSimPhone(order.Phone); ok {
		dto.PhoneTarget = &phone
		dto.Phone = phone.E164Number
	}
	return dto
}

func parseFiveSimPhone(value string) (fiveSimPhoneTarget, bool) {
	parsed, err := phonenumbers.Parse(strings.TrimSpace(value), "")
	if err != nil || !phonenumbers.IsPossibleNumber(parsed) {
		return fiveSimPhoneTarget{}, false
	}
	region := phonenumbers.GetRegionCodeForNumber(parsed)
	return fiveSimPhoneTarget{
		Region:             region,
		Phone:              phonenumbers.GetNationalSignificantNumber(parsed),
		E164Number:         phonenumbers.Format(parsed, phonenumbers.E164),
		CountryCallingCode: fmt.Sprint(parsed.GetCountryCode()),
		CountryISO2:        region,
	}, true
}

func writeFiveSimError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"error": fivesim.SanitizeAPIError(err.Error())})
}

func floatField(data map[string]any, key string) float64 {
	value, ok := data[key]
	if !ok || value == nil {
		return 0
	}
	switch typed := value.(type) {
	case json.Number:
		parsed, err := typed.Float64()
		if err == nil {
			return parsed
		}
	case float64:
		return typed
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(typed), 64)
		if err == nil {
			return parsed
		}
	}
	return 0
}

func redactedPhone(value string) string {
	if strings.TrimSpace(value) == "" {
		return ""
	}
	digits := nonDigits.ReplaceAllString(value, "")
	if len(digits) <= 4 {
		return "***"
	}
	return "+" + strings.Repeat("*", max(0, len(digits)-4)) + digits[len(digits)-4:]
}
