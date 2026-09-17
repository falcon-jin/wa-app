package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type memoryFiveSimTokenStore struct {
	token   string
	present bool
}

func (s *memoryFiveSimTokenStore) Load() (string, bool, error) {
	return s.token, s.present, nil
}

func (s *memoryFiveSimTokenStore) Save(token string) error {
	s.token = token
	s.present = true
	return nil
}

func TestFileFiveSimTokenStorePersistsAndClearsToken(t *testing.T) {
	store := newFileFiveSimTokenStore(t.TempDir())

	if _, present, err := store.Load(); err != nil || present {
		t.Fatalf("initial Load() = present %v, err %v; want absent", present, err)
	}
	if err := store.Save("test-token"); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	if token, present, err := store.Load(); err != nil || !present || token != "test-token" {
		t.Fatalf("Load() = token %q, present %v, err %v; want persisted token", token, present, err)
	}
	if err := store.Save(""); err != nil {
		t.Fatalf("Save(clear) error = %v", err)
	}
	if token, present, err := store.Load(); err != nil || !present || token != "" {
		t.Fatalf("Load(clear) = token %q, present %v, err %v; want present empty token", token, present, err)
	}
}

func TestNewDashboardFiveSimConfigPrefersPersistedToken(t *testing.T) {
	store := &memoryFiveSimTokenStore{token: "persisted-token", present: true}
	config, err := newDashboardFiveSimConfig("environment-token", "https://example.test", store)
	if err != nil {
		t.Fatalf("newDashboardFiveSimConfig() error = %v", err)
	}
	token, baseURL := config.snapshot()
	if token != "persisted-token" || baseURL != "https://example.test" {
		t.Fatalf("snapshot() = token %q, base URL %q; want persisted token and configured URL", token, baseURL)
	}
}

func TestHandleFiveSimConfigDoesNotExposeToken(t *testing.T) {
	store := &memoryFiveSimTokenStore{}
	config, err := newDashboardFiveSimConfig("", "", store)
	if err != nil {
		t.Fatalf("newDashboardFiveSimConfig() error = %v", err)
	}
	server := &dashboardHTTP{fiveSim: config}
	request := httptest.NewRequest(http.MethodPost, "/api/wa/debug/5sim/config", strings.NewReader(`{"token":"test-token"}`))
	response := httptest.NewRecorder()

	server.handleFiveSimConfig(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d; want %d", response.Code, http.StatusOK)
	}
	body, err := io.ReadAll(response.Result().Body)
	if err != nil {
		t.Fatalf("read response body: %v", err)
	}
	if strings.Contains(string(body), "test-token") {
		t.Fatalf("response body contains the configured token: %s", body)
	}
	if !strings.Contains(string(body), `"configured":true`) {
		t.Fatalf("response body = %s; want configured status", body)
	}
	if !config.configured() || store.token != "test-token" {
		t.Fatalf("configured token was not applied")
	}
}

func TestHandleFiveSimConfigRejectsInvalidTokenPayload(t *testing.T) {
	config, err := newDashboardFiveSimConfig("", "", &memoryFiveSimTokenStore{})
	if err != nil {
		t.Fatalf("newDashboardFiveSimConfig() error = %v", err)
	}
	server := &dashboardHTTP{fiveSim: config}

	tests := []struct {
		name string
		body string
	}{
		{name: "missing token", body: `{}`},
		{name: "non string token", body: `{"token":123}`},
		{name: "oversized token", body: `{"token":"` + strings.Repeat("x", maxFiveSimTokenLength+1) + `"}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/api/wa/debug/5sim/config", strings.NewReader(test.body))
			response := httptest.NewRecorder()

			server.handleFiveSimConfig(response, request)

			if response.Code != http.StatusBadRequest {
				t.Fatalf("status = %d; want %d", response.Code, http.StatusBadRequest)
			}
		})
	}
}
