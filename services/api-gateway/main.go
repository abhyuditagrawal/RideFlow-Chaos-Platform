// api-gateway — single ingress point: routing, request-ID injection, rate
// limiting, circuit breaking, response aggregation.
//
// Health-check semantics (critical — this is what Route 53 keys off):
//   /healthz         200 if the process can serve. Never checks downstreams —
//                     otherwise one dependency failure restarts every gateway
//                     pod, turning a partial failure into a total one.
//   /readyz           200 only if >=3 of 4 downstreams are reachable.
//   /healthz/region   aggregate regional health; the chaos injector can force
//                     this to fail to simulate a full regional outage (F6).
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log"
	"math/rand"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
	errShortCircuit = errors.New("circuit open")
	errUpstream5xx  = errors.New("upstream 5xx")
)

const service = "api-gateway"

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

var (
	port       = getenv("PORT", "8080")
	region     = getenv("REGION", "local")
	userURL    = getenv("USER_SERVICE_URL", "http://user-service:8081")
	rideURL    = getenv("RIDE_SERVICE_URL", "http://ride-service:8082")
	driverURL  = getenv("DRIVER_SERVICE_URL", "http://driver-service:8083")
	pricingURL = getenv("PRICING_SERVICE_URL", "http://pricing-service:8084")

	httpRequests = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "http_requests_total", Help: "requests",
	}, []string{"service", "method", "route", "code"})
	httpDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name: "http_request_duration_seconds", Help: "latency",
	}, []string{"service", "method", "route"})
	depRequests = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "dependency_requests_total", Help: "dependency calls",
	}, []string{"service", "dependency", "outcome"})
	cbState = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "circuit_breaker_state", Help: "0 closed 1 half 2 open",
	}, []string{"service", "dependency"})

	regionHealthy = true // flipped by chaos injector via env override or /admin toggle
)

// ---- circuit breaker ----

type breaker struct {
	mu         sync.Mutex
	failures   int
	state      int // 0 closed, 1 half-open, 2 open
	openedAt   time.Time
}

func (b *breaker) allow() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.state == 2 {
		if time.Since(b.openedAt) >= 15*time.Second {
			b.state = 1
			return true
		}
		return false
	}
	return true
}

func (b *breaker) success() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.failures = 0
	b.state = 0
}

func (b *breaker) failure() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.failures++
	if b.state == 1 || b.failures >= 5 {
		b.state = 2
		b.openedAt = time.Now()
	}
}

var breakers = map[string]*breaker{
	"user-service": {}, "ride-service": {}, "driver-service": {}, "pricing-service": {},
}

// ---- token-bucket rate limiter per client IP ----

type bucket struct {
	tokens   float64
	lastFill time.Time
}

var (
	buckets   = map[string]*bucket{}
	bucketsMu sync.Mutex
	rateLimit = 100.0 // req/s per client IP
)

func allowRate(ip string) bool {
	bucketsMu.Lock()
	defer bucketsMu.Unlock()
	b, ok := buckets[ip]
	if !ok {
		b = &bucket{tokens: rateLimit, lastFill: time.Now()}
		buckets[ip] = b
	}
	elapsed := time.Since(b.lastFill).Seconds()
	b.tokens = min(rateLimit, b.tokens+elapsed*rateLimit)
	b.lastFill = time.Now()
	if b.tokens >= 1 {
		b.tokens--
		return true
	}
	return false
}

func min(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}

// ---- proxy with retries + circuit breaking ----

var httpClient = &http.Client{
	Timeout: 2 * time.Second,
	Transport: &http.Transport{
		DialContext: (&net.Dialer{Timeout: 800 * time.Millisecond}).DialContext,
	},
}

func bytesReader(b []byte) io.Reader {
	if b == nil {
		return nil
	}
	return bytes.NewReader(b)
}

func proxyJSON(depName, method, targetURL string, body []byte, idempotent bool) (int, []byte, error) {
	b := breakers[depName]
	if !b.allow() {
		depRequests.WithLabelValues(service, depName, "short_circuited").Inc()
		return 0, nil, errShortCircuit
	}
	attempts := 1
	if idempotent {
		attempts = 3
	}
	var lastErr error
	for i := 0; i < attempts; i++ {
		if i > 0 {
			backoff := time.Duration(50*(1<<i))*time.Millisecond + time.Duration(rand.Intn(50))*time.Millisecond
			time.Sleep(backoff)
		}
		req, _ := http.NewRequest(method, targetURL, bytesReader(body))
		req.Header.Set("Content-Type", "application/json")
		resp, err := httpClient.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		data, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode >= 500 {
			lastErr = errUpstream5xx
			continue
		}
		b.success()
		depRequests.WithLabelValues(service, depName, "success").Inc()
		return resp.StatusCode, data, nil
	}
	b.failure()
	depRequests.WithLabelValues(service, depName, "failure").Inc()
	return 0, nil, lastErr
}

func clientIP(r *http.Request) string {
	// RemoteAddr is "host:port" — the port is a fresh ephemeral value on
	// every connection, so keying the rate limiter on the raw RemoteAddr
	// gives every request its own full bucket and never throttles anything.
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func chaosMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		ip := clientIP(r)
		if !allowRate(ip) {
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		reqID := r.Header.Get("x-request-id")
		if reqID == "" {
			reqID = randomID()
		}
		w.Header().Set("x-request-id", reqID)

		rec := &statusRecorder{ResponseWriter: w, status: 200}
		next(rec, r)

		httpDuration.WithLabelValues(service, r.Method, r.URL.Path).Observe(time.Since(start).Seconds())
		httpRequests.WithLabelValues(service, r.Method, r.URL.Path, strconv.Itoa(rec.status)).Inc()
		for name := range breakers {
			cbState.WithLabelValues(service, name).Set(float64(breakers[name].state))
		}
	}
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

func randomID() string {
	const letters = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, 12)
	for i := range b {
		b[i] = letters[rand.Intn(len(letters))]
	}
	return string(b)
}

// ---- health endpoints ----

func healthz(w http.ResponseWriter, r *http.Request) {
	json.NewEncoder(w).Encode(map[string]string{"status": "ok", "service": service, "region": region})
}

func downstreamOK(target string) bool {
	req, _ := http.NewRequest("GET", target+"/healthz", nil)
	c := &http.Client{Timeout: 800 * time.Millisecond}
	resp, err := c.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == 200
}

func readyz(w http.ResponseWriter, r *http.Request) {
	targets := []string{userURL, rideURL, driverURL, pricingURL}
	ok := 0
	for _, t := range targets {
		if downstreamOK(t) {
			ok++
		}
	}
	if ok >= 3 {
		json.NewEncoder(w).Encode(map[string]any{"status": "ready", "downstreamsHealthy": ok})
		return
	}
	w.WriteHeader(http.StatusServiceUnavailable)
	json.NewEncoder(w).Encode(map[string]any{"status": "not ready", "downstreamsHealthy": ok})
}

func healthzRegion(w http.ResponseWriter, r *http.Request) {
	// CHAOS_REGION_HEALTH_OVERRIDE / query param lets the chaos injector or a
	// manual failover test (doc Phase 4) force this endpoint unhealthy.
	override := getenv("REGION_HEALTH_OVERRIDE", "healthy")
	if override == "unhealthy" || !regionHealthy {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{"status": "unhealthy", "region": region})
		return
	}
	json.NewEncoder(w).Encode(map[string]string{"status": "healthy", "region": region})
}

func adminRegionToggle(w http.ResponseWriter, r *http.Request) {
	// used by the chaos injector's region-failure experiment (F6)
	state := r.URL.Query().Get("state")
	regionHealthy = state != "unhealthy"
	json.NewEncoder(w).Encode(map[string]bool{"regionHealthy": regionHealthy})
}

// ---- proxy handlers ----

func createRide(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	status, data, err := proxyJSON("ride-service", "POST", rideURL+"/internal/rides", body, false)
	writeProxyResult(w, status, data, err)
}

func getRide(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	status, data, err := proxyJSON("ride-service", "GET", rideURL+"/internal/rides/"+id, nil, true)
	writeProxyResult(w, status, data, err)
}

func listRides(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	params := url.Values{}
	if u := q.Get("userId"); u != "" {
		params.Set("userId", u)
	}
	if l := q.Get("limit"); l != "" {
		params.Set("limit", l)
	}
	status, data, err := proxyJSON("ride-service", "GET", rideURL+"/internal/rides?"+params.Encode(), nil, true)
	writeProxyResult(w, status, data, err)
}

func cancelRide(w http.ResponseWriter, r *http.Request) {
	id := url.PathEscape(r.PathValue("id"))
	status, data, err := proxyJSON("ride-service", "POST", rideURL+"/internal/rides/"+id+"/cancel", nil, false)
	writeProxyResult(w, status, data, err)
}

func nearbyDrivers(w http.ResponseWriter, r *http.Request) {
	q := r.URL.RawQuery
	status, data, err := proxyJSON("driver-service", "GET", driverURL+"/v1/drivers/nearby?"+q, nil, true)
	writeProxyResult(w, status, data, err)
}

func usersMe(w http.ResponseWriter, r *http.Request) {
	req, _ := http.NewRequest("GET", userURL+"/v1/users/me", nil)
	req.Header.Set("Authorization", r.Header.Get("Authorization"))
	c := &http.Client{Timeout: 2 * time.Second}
	resp, err := c.Do(req)
	if err != nil {
		depRequests.WithLabelValues(service, "user-service", "failure").Inc()
		w.WriteHeader(http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	depRequests.WithLabelValues(service, "user-service", "success").Inc()
	writeProxyResult(w, resp.StatusCode, data, nil)
}

func authLogin(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	status, data, err := proxyJSON("user-service", "POST", userURL+"/v1/auth/login", body, false)
	writeProxyResult(w, status, data, err)
}

func registerUser(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	status, data, err := proxyJSON("user-service", "POST", userURL+"/v1/users", body, false)
	writeProxyResult(w, status, data, err)
}

func writeProxyResult(w http.ResponseWriter, status int, data []byte, err error) {
	if err == errShortCircuit {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{"error": "dependency circuit open"})
		return
	}
	if err != nil {
		w.WriteHeader(http.StatusBadGateway)
		json.NewEncoder(w).Encode(map[string]string{"error": "upstream error"})
		return
	}
	if status == 0 {
		status = 200
	}
	w.WriteHeader(status)
	w.Write(data)
}

func metrics(w http.ResponseWriter, r *http.Request) {
	promhttp.Handler().ServeHTTP(w, r)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", chaosMiddleware(healthz))
	mux.HandleFunc("GET /readyz", chaosMiddleware(readyz))
	mux.HandleFunc("GET /healthz/region", chaosMiddleware(healthzRegion))
	mux.HandleFunc("POST /admin/region", chaosMiddleware(adminRegionToggle))
	mux.HandleFunc("GET /metrics", metrics)

	mux.HandleFunc("POST /v1/rides", chaosMiddleware(createRide))
	mux.HandleFunc("GET /v1/rides", chaosMiddleware(listRides))
	mux.HandleFunc("GET /v1/rides/{id}", chaosMiddleware(getRide))
	mux.HandleFunc("POST /v1/rides/{id}/cancel", chaosMiddleware(cancelRide))
	mux.HandleFunc("GET /v1/drivers/nearby", chaosMiddleware(nearbyDrivers))
	mux.HandleFunc("GET /v1/users/me", chaosMiddleware(usersMe))
	mux.HandleFunc("POST /v1/auth/login", chaosMiddleware(authLogin))
	mux.HandleFunc("POST /v1/users", chaosMiddleware(registerUser))

	log.Printf("%s listening on :%s (region=%s)", service, port, region)
	log.Fatal(http.ListenAndServe(":"+port, mux))
}
