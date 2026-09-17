package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

const (
	fiveSimTokenFileName  = "fivesim-token"
	maxFiveSimTokenLength = 512
)

var errFiveSimTokenTooLong = errors.New("5sim token is too long")

type fiveSimTokenStore interface {
	Load() (token string, present bool, err error)
	Save(token string) error
}

type fileFiveSimTokenStore struct {
	path string
}

func newFileFiveSimTokenStore(dataDir string) *fileFiveSimTokenStore {
	return &fileFiveSimTokenStore{path: filepath.Join(dataDir, fiveSimTokenFileName)}
}

func (s *fileFiveSimTokenStore) Load() (string, bool, error) {
	data, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("read 5sim token: %w", err)
	}
	return strings.TrimSpace(string(data)), true, nil
}

func (s *fileFiveSimTokenStore) Save(token string) error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return fmt.Errorf("create 5sim token directory: %w", err)
	}
	if err := os.WriteFile(s.path, []byte(token), 0o600); err != nil {
		return fmt.Errorf("write 5sim token: %w", err)
	}
	if err := os.Chmod(s.path, 0o600); err != nil {
		return fmt.Errorf("protect 5sim token: %w", err)
	}
	return nil
}

type dashboardFiveSimConfig struct {
	mu         sync.RWMutex
	token      string
	apiBaseURL string
	tokenStore fiveSimTokenStore
}

func newDashboardFiveSimConfig(envToken, apiBaseURL string, tokenStore fiveSimTokenStore) (*dashboardFiveSimConfig, error) {
	token := strings.TrimSpace(envToken)
	if tokenStore != nil {
		persisted, present, err := tokenStore.Load()
		if err != nil {
			return nil, err
		}
		if present {
			token = strings.TrimSpace(persisted)
		}
	}
	return &dashboardFiveSimConfig{
		token:      token,
		apiBaseURL: strings.TrimSpace(apiBaseURL),
		tokenStore: tokenStore,
	}, nil
}

func (c *dashboardFiveSimConfig) snapshot() (string, string) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.token, c.apiBaseURL
}

func (c *dashboardFiveSimConfig) configured() bool {
	token, _ := c.snapshot()
	return strings.TrimSpace(token) != ""
}

func (c *dashboardFiveSimConfig) setToken(value string) error {
	token := strings.TrimSpace(value)
	if len(token) > maxFiveSimTokenLength {
		return errFiveSimTokenTooLong
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.tokenStore != nil {
		if err := c.tokenStore.Save(token); err != nil {
			return err
		}
	}
	c.token = token
	return nil
}
