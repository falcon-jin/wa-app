package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	proxyruntimev1 "github.com/byte-v-forge/common-lib/gen/go/byte/v/forge/contracts/proxyruntime/v1"
	"github.com/byte-v-forge/common-lib/protojsonx"
	waappv1 "github.com/byte-v-forge/wa-app/gen/go/byte/v/forge/waapp/v1"
	"google.golang.org/protobuf/types/known/durationpb"
)

type DynamicProxyLease struct {
	AccountID string
	LeaseID   string
	ProxyURL  string
}

type DynamicProxyRuntime struct {
	baseURL string
	client  *http.Client
}

const proxyRuntimeGatewayPort = "10810"

func NewDynamicProxyRuntime(baseURL string) *DynamicProxyRuntime {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" {
		return nil
	}
	return &DynamicProxyRuntime{baseURL: baseURL, client: &http.Client{Timeout: 20 * time.Second}}
}

func (p *DynamicProxyRuntime) AcquireUSDynamic(ctx context.Context, purpose string, correlationID string, leaseTTL time.Duration) (DynamicProxyLease, error) {
	if p == nil || p.baseURL == "" {
		return DynamicProxyLease{}, NewError(waappv1.WaErrorCode_WA_ERROR_CODE_VALIDATION_FAILED, "PROXY_RUNTIME_API_BASE_URL is required", false)
	}
	endpoint, err := p.endpoint("/proxies/resolve")
	if err != nil {
		return DynamicProxyLease{}, err
	}
	purpose = firstNonEmpty(purpose, "WA_DYNAMIC_PROXY")
	ttl := 600 * time.Second
	if leaseTTL > 0 {
		ttl = leaseTTL.Round(time.Second)
	}
	requestBody := &proxyruntimev1.ResolveProxyRequest{
		ProxyKind:   proxyruntimev1.ProxyKind_PROXY_KIND_DYNAMIC_IP,
		CountryCode: "US",
		Purpose:     purpose,
		Ttl:         durationpb.New(ttl),
		ForceNew:    true,
		Strategy:    proxyruntimev1.ProxySelectorStrategy_PROXY_SELECTOR_STRATEGY_HASH_TARGET_HOST,
	}
	data, err := protojsonx.Marshal(requestBody)
	if err != nil {
		return DynamicProxyLease{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(data))
	if err != nil {
		return DynamicProxyLease{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := p.client.Do(req)
	if err != nil {
		return DynamicProxyLease{}, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return DynamicProxyLease{}, proxyRuntimeRouteError("dynamic proxy", resp.StatusCode, body)
	}
	var resolved proxyruntimev1.ResolveProxyResponse
	if err := protojsonx.Unmarshal(body, &resolved); err != nil {
		return DynamicProxyLease{}, err
	}
	proxy := resolved.GetProxy()
	proxyURL := strings.TrimSpace(proxy.GetProxyUrl())
	if proxyURL == "" {
		return DynamicProxyLease{}, fmt.Errorf("proxy-runtime dynamic proxy is unavailable")
	}
	return DynamicProxyLease{AccountID: proxy.GetAssignmentId(), LeaseID: proxy.GetLeaseId(), ProxyURL: proxyURL}, nil
}

func (p *DynamicProxyRuntime) GatewayProxyURL(ctx context.Context, username string) (string, error) {
	if p == nil || p.baseURL == "" {
		return "", NewError(waappv1.WaErrorCode_WA_ERROR_CODE_VALIDATION_FAILED, "PROXY_RUNTIME_API_BASE_URL is required", false)
	}
	username = strings.TrimSpace(username)
	if username == "" {
		return "", NewError(waappv1.WaErrorCode_WA_ERROR_CODE_VALIDATION_FAILED, "gateway username is required", false)
	}
	endpoint, err := p.endpoint("/settings/ingress-rules")
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return "", err
	}
	resp, err := p.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", proxyRuntimeRouteError("gateway ingress", resp.StatusCode, body)
	}
	var settings proxyruntimev1.GetProxyRuntimeSettingsResponse
	if err := protojsonx.Unmarshal(body, &settings); err != nil {
		return "", err
	}
	for _, rule := range settings.GetSettings().GetIngressRules() {
		if !rule.GetEnabled() || strings.TrimSpace(rule.GetUsername()) != username {
			continue
		}
		return p.gatewayProxyURL(username, rule.GetPasswordValue())
	}
	return "", NewError(waappv1.WaErrorCode_WA_ERROR_CODE_ROUTE_UNAVAILABLE, fmt.Sprintf("proxy-runtime gateway user %q is unavailable", username), true)
}

func (p *DynamicProxyRuntime) Release(ctx context.Context, accountID string) {
	if p == nil || strings.TrimSpace(accountID) == "" {
		return
	}
	endpoint, err := p.endpoint("/leases/release")
	if err != nil {
		return
	}
	data, _ := json.Marshal(map[string]string{"account_id": accountID})
	reqCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, endpoint, bytes.NewReader(data))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := p.client.Do(req)
	if err == nil && resp != nil {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1024))
		_ = resp.Body.Close()
	}
}

func (p *DynamicProxyRuntime) endpoint(path string) (string, error) {
	parsed, err := url.Parse(strings.TrimRight(strings.TrimSpace(p.baseURL), "/"))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", fmt.Errorf("invalid PROXY_RUNTIME_API_BASE_URL")
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/") + path
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String(), nil
}

func (p *DynamicProxyRuntime) gatewayProxyURL(username string, password string) (string, error) {
	parsed, err := url.Parse(strings.TrimRight(strings.TrimSpace(p.baseURL), "/"))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", fmt.Errorf("invalid PROXY_RUNTIME_API_BASE_URL")
	}
	host := strings.TrimSpace(parsed.Hostname())
	if host == "" {
		return "", fmt.Errorf("invalid PROXY_RUNTIME_API_BASE_URL")
	}
	gateway := &url.URL{
		Scheme: "http",
		User:   url.UserPassword(username, password),
		Host:   net.JoinHostPort(host, proxyRuntimeGatewayPort),
	}
	return gateway.String(), nil
}

func proxyRuntimeRouteError(resource string, statusCode int, body []byte) error {
	message := fmt.Sprintf("proxy-runtime %s unavailable: HTTP %d", strings.TrimSpace(resource), statusCode)
	if detail := proxyRuntimeErrorDetail(body); detail != "" {
		message += ": " + detail
	}
	return NewError(waappv1.WaErrorCode_WA_ERROR_CODE_ROUTE_UNAVAILABLE, message, true)
}

func proxyRuntimeErrorDetail(body []byte) string {
	var payload struct {
		Message string `json:"message"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return ""
	}
	detail := strings.Join(strings.Fields(payload.Message), " ")
	if detail == "" || strings.Contains(detail, "://") {
		return ""
	}
	const maxDetailLength = 180
	if len(detail) > maxDetailLength {
		return detail[:maxDetailLength]
	}
	return detail
}
