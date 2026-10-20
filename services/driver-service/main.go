// driver-service — driver location ingestion and geospatial matching.
//
// This is the most interesting chaos target: it is latency-sensitive and has
// an external stateful dependency (Redis), so network-latency injection
// produces visible, explainable degradation.
package main

import (
	"context"
	"encoding/json"
	"log"
	"math/rand"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/redis/go-redis/v9"
)

const service = "driver-service"

var (
	port     = getenv("PORT", "8083")
	region   = getenv("REGION", "local")
	redisURL = getenv("REDIS_URL", "redis://redis:6379")

	httpRequests = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "http_requests_total", Help: "requests",
	}, []string{"service", "method", "route", "code"})
	httpDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name: "http_request_duration_seconds", Help: "latency",
	}, []string{"service", "method", "route"})
	inflight = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "http_requests_in_flight", Help: "in flight",
	}, []string{"service"})
	depRequests = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "dependency_requests_total", Help: "dependency calls",
	}, []string{"service", "dependency", "outcome"})
	matchDuration = promauto.NewHistogram(prometheus.HistogramOpts{
		Name: "driver_match_duration_seconds", Help: "time to find a match",
	})
)

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

var rdb *redis.Client
var ctx = context.Background()
var runtimeFault = os.Getenv("CHAOS_INJECT")

func setChaos(w http.ResponseWriter, r *http.Request) {
	runtimeFault = r.URL.Query().Get("mode")
	json.NewEncoder(w).Encode(map[string]string{"mode": runtimeFault})
}

func chaosMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		inflight.WithLabelValues(service).Inc()
		start := time.Now()
		fault := r.Header.Get("x-chaos-fault")
		if fault == "" {
			fault = runtimeFault
		}
		if fault == "error" {
			inflight.WithLabelValues(service).Dec()
			w.WriteHeader(http.StatusInternalServerError)
			httpRequests.WithLabelValues(service, r.Method, r.URL.Path, "500").Inc()
			return
		}
		if fault == "latency" {
			ms, _ := strconv.Atoi(getenv("CHAOS_LATENCY_MS", "300"))
			time.Sleep(time.Duration(ms) * time.Millisecond)
		}
		rec := &statusRecorder{ResponseWriter: w, status: 200}
		next(rec, r)
		inflight.WithLabelValues(service).Dec()
		httpDuration.WithLabelValues(service, r.Method, r.URL.Path).Observe(time.Since(start).Seconds())
		httpRequests.WithLabelValues(service, r.Method, r.URL.Path, strconv.Itoa(rec.status)).Inc()
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

func healthz(w http.ResponseWriter, r *http.Request) {
	json.NewEncoder(w).Encode(map[string]string{"status": "ok", "service": service, "region": region})
}

func readyz(w http.ResponseWriter, r *http.Request) {
	if err := rdb.Ping(ctx).Err(); err != nil {
		depRequests.WithLabelValues(service, "redis", "failure").Inc()
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{"status": "not ready", "reason": "redis unreachable"})
		return
	}
	depRequests.WithLabelValues(service, "redis", "success").Inc()
	json.NewEncoder(w).Encode(map[string]string{"status": "ready"})
}

type locationUpdate struct {
	Lat float64 `json:"lat"`
	Lng float64 `json:"lng"`
}

func updateLocation(w http.ResponseWriter, r *http.Request) {
	driverID := r.PathValue("id")
	var loc locationUpdate
	if err := json.NewDecoder(r.Body).Decode(&loc); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	pipe := rdb.TxPipeline()
	pipe.GeoAdd(ctx, "drivers:available", &redis.GeoLocation{Name: driverID, Longitude: loc.Lng, Latitude: loc.Lat})
	pipe.SetEx(ctx, "driver:"+driverID+":ttl", "1", 30*time.Second)
	if _, err := pipe.Exec(ctx); err != nil {
		depRequests.WithLabelValues(service, "redis", "failure").Inc()
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	depRequests.WithLabelValues(service, "redis", "success").Inc()
	w.WriteHeader(http.StatusNoContent)
}

type matchRequest struct {
	Lat      float64 `json:"lat"`
	Lng      float64 `json:"lng"`
	RadiusKm float64 `json:"radiusKm"`
}

func match(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	var req matchRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	if req.RadiusKm == 0 {
		req.RadiusKm = 5
	}
	results, err := rdb.GeoSearch(ctx, "drivers:available", &redis.GeoSearchQuery{
		Longitude: req.Lng, Latitude: req.Lat, Radius: req.RadiusKm, RadiusUnit: "km",
		Sort: "ASC", Count: 10,
	}).Result()
	if err != nil {
		depRequests.WithLabelValues(service, "redis", "failure").Inc()
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	depRequests.WithLabelValues(service, "redis", "success").Inc()
	if len(results) == 0 {
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]string{"error": "no drivers available"})
		return
	}
	driverID := results[0]
	eta := 2 + rand.Intn(8)
	matchDuration.Observe(time.Since(start).Seconds())
	json.NewEncoder(w).Encode(map[string]any{"driverId": driverID, "eta": eta})
}

func nearby(w http.ResponseWriter, r *http.Request) {
	lat, _ := strconv.ParseFloat(r.URL.Query().Get("lat"), 64)
	lng, _ := strconv.ParseFloat(r.URL.Query().Get("lng"), 64)
	radius, _ := strconv.ParseFloat(r.URL.Query().Get("radius"), 64)
	if radius == 0 {
		radius = 5
	}
	results, err := rdb.GeoSearchLocation(ctx, "drivers:available", &redis.GeoSearchLocationQuery{
		GeoSearchQuery: redis.GeoSearchQuery{
			Longitude: lng, Latitude: lat, Radius: radius, RadiusUnit: "km", Sort: "ASC", Count: 20,
		},
		WithCoord: true,
		WithDist:  true,
	}).Result()
	if err != nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	drivers := make([]map[string]any, 0, len(results))
	for _, d := range results {
		drivers = append(drivers, map[string]any{"id": d.Name, "lat": d.Latitude, "lng": d.Longitude, "distKm": d.Dist})
	}
	json.NewEncoder(w).Encode(map[string]any{"drivers": drivers})
}

func metrics(w http.ResponseWriter, r *http.Request) {
	promhttp.Handler().ServeHTTP(w, r)
}

func main() {
	opt, err := redis.ParseURL(redisURL)
	if err != nil {
		log.Fatalf("invalid REDIS_URL: %v", err)
	}
	rdb = redis.NewClient(opt)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", chaosMiddleware(healthz))
	mux.HandleFunc("GET /readyz", chaosMiddleware(readyz))
	mux.HandleFunc("GET /metrics", metrics)
	mux.HandleFunc("PATCH /admin/chaos", setChaos)
	mux.HandleFunc("POST /internal/match", chaosMiddleware(match))
	mux.HandleFunc("PUT /internal/drivers/{id}/location", chaosMiddleware(updateLocation))
	mux.HandleFunc("GET /v1/drivers/nearby", chaosMiddleware(nearby))

	log.Printf("%s listening on :%s (region=%s)", service, port, region)
	log.Fatal(http.ListenAndServe(":"+port, mux))
}
