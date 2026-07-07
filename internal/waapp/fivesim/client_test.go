package fivesim

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestNormalizeWhatsAppInventoryFromProductPrices(t *testing.T) {
	raw := []byte(`{
		"whatsapp": {
			"argentina": {
				"virtual34": {"cost": 0.2513, "count": 118610, "rate": 98.7},
				"virtual35": {"cost": 0.3000, "count": 0}
			},
			"england": {
				"vodafone": {"cost": 4, "count": 1260, "rate": 99.99}
			}
		}
	}`)

	items, err := NormalizeWhatsAppInventory(raw)
	if err != nil {
		t.Fatalf("NormalizeWhatsAppInventory: %v", err)
	}

	if len(items) != 3 {
		t.Fatalf("items length = %d, want 3", len(items))
	}
	first := items[0]
	if first.Country != "argentina" || first.Operator != "virtual34" || first.Cost != 0.2513 || first.Count != 118610 || first.Rate == nil || *first.Rate != 98.7 {
		t.Fatalf("first item mismatch: %#v", first)
	}
}

func TestDecodeOrderExtractsSMSCodeWithoutExposingText(t *testing.T) {
	raw := []byte(`{
		"id": 11631253,
		"phone": "+447350690992",
		"operator": "vodafone",
		"product": "whatsapp",
		"price": 21,
		"status": "RECEIVED",
		"expires": "2018-10-13T08:28:38.809469028Z",
		"sms": [
			{"sender": "WhatsApp", "text": "WhatsApp code 123456. Do not share.", "code": "123456"}
		],
		"country": "england"
	}`)

	order, err := DecodeOrder(raw)
	if err != nil {
		t.Fatalf("DecodeOrder: %v", err)
	}

	if order.ID != 11631253 || order.SMSCode != "123456" || order.SMSCount != 1 {
		t.Fatalf("order mismatch: %#v", order)
	}
	encoded, err := json.Marshal(order)
	if err != nil {
		t.Fatalf("marshal order: %v", err)
	}
	if strings.Contains(string(encoded), "Do not share") || strings.Contains(string(encoded), "WhatsApp code") {
		t.Fatalf("order JSON exposed sms text: %s", encoded)
	}
}

func TestDecodeOrderReturns5SimTextError(t *testing.T) {
	_, err := DecodeOrder([]byte(`no free phones for +447350690992 with code 123456`))
	if err == nil {
		t.Fatal("DecodeOrder returned nil, want 5sim response error")
	}
	got := err.Error()
	if !strings.Contains(got, "no free phones") {
		t.Fatalf("error = %q, want 5sim text reason", got)
	}
	if strings.Contains(got, "+447350690992") || strings.Contains(got, "123456") {
		t.Fatalf("error leaked sensitive value: %q", got)
	}
}

func TestDecodeOrderReturns5SimJSONError(t *testing.T) {
	_, err := DecodeOrder([]byte(`{"error":"not enough balance","phone":"+447350690992"}`))
	if err == nil {
		t.Fatal("DecodeOrder returned nil, want 5sim response error")
	}
	if got := err.Error(); got != "5sim response error: not enough balance" {
		t.Fatalf("error = %q", got)
	}
}

func TestValidateBuyRequestRejectsMaxPriceBelowInventory(t *testing.T) {
	err := ValidateBuyRequest(BuyRequest{
		Country:  "argentina",
		Operator: "virtual34",
		MaxPrice: 0.20,
		Inventory: []InventoryItem{{
			Country:  "argentina",
			Operator: "virtual34",
			Cost:     0.2513,
			Count:    1,
		}},
	})
	if err == nil {
		t.Fatal("ValidateBuyRequest returned nil, want price error")
	}
	if got := err.Error(); got != "selected 5sim price 0.2513 exceeds max price 0.2" {
		t.Fatalf("error = %q", got)
	}
}

func TestSanitizeAPIErrorDoesNotLeakTokenPhoneOrOTP(t *testing.T) {
	got := SanitizeAPIError("Authorization Bearer secret-token failed for +447350690992 sms 123456")
	if strings.Contains(got, "secret-token") || strings.Contains(got, "+447350690992") || strings.Contains(got, "123456") {
		t.Fatalf("sanitized error leaked sensitive value: %q", got)
	}
}
