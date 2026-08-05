"""
Metrics & Monitoring Module — telemetry collection and performance monitoring.
Tracks connection stats, bandwidth usage, latency, and system health.
"""
from dataclasses import dataclass, field
from typing import Optional, Dict, List
import time as _time
import threading
import statistics


@dataclass
class Counter:
    """Monotonically increasing counter."""
    name: str
    value: int = 0
    labels: Dict[str, str] = field(default_factory=dict)

    def inc(self, amount: int = 1):
        self.value += amount

    def to_dict(self) -> dict:
        return {"name": self.name, "value": self.value, "labels": self.labels}


@dataclass
class Gauge:
    """Value that can go up and down."""
    name: str
    value: float = 0.0
    labels: Dict[str, str] = field(default_factory=dict)

    def set(self, value: float):
        self.value = value

    def to_dict(self) -> dict:
        return {"name": self.name, "value": self.value, "labels": self.labels}


@dataclass
class Histogram:
    """Distribution of values."""
    name: str
    buckets: List[float] = field(default_factory=lambda:
        [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1.0, 5.0, 10.0])
    bucket_counts: List[int] = field(default_factory=list)
    _samples: List[float] = field(default_factory=list)
    count: int = 0
    sum: float = 0.0
    labels: Dict[str, str] = field(default_factory=dict)

    def __post_init__(self):
        if not self.bucket_counts:
            self.bucket_counts = [0] * (len(self.buckets) + 1)

    def observe(self, value: float):
        self._samples.append(value)
        self.count += 1
        self.sum += value
        for i, bound in enumerate(self.buckets):
            if value <= bound:
                self.bucket_counts[i] += 1
                return
        self.bucket_counts[-1] += 1

    def to_dict(self) -> dict:
        recent = self._samples[-100:] if self._samples else []
        return {
            "name": self.name,
            "count": self.count,
            "sum": round(self.sum, 4),
            "avg": round(self.sum / self.count, 4) if self.count > 0 else 0,
            "p50": round(statistics.median(recent), 4) if recent else 0,
            "p95": round(_percentile(recent, 95), 4) if recent else 0,
            "p99": round(_percentile(recent, 99), 4) if recent else 0,
            "min": round(min(recent), 4) if recent else 0,
            "max": round(max(recent), 4) if recent else 0,
            "labels": self.labels
        }


def _percentile(data: List[float], p: float) -> float:
    if not data:
        return 0
    k = (len(data) - 1) * p / 100
    f = int(k)
    c = k - f
    if f + 1 < len(data):
        return sorted(data)[f] * (1 - c) + sorted(data)[f + 1] * c
    return sorted(data)[f]


@dataclass
class ConnectionMetrics:
    """Per-connection telemetry."""
    conn_id: str = ""
    exit_id: str = ""
    protocol: str = "tcp"
    bytes_sent: int = 0
    bytes_received: int = 0
    latency_samples: List[float] = field(default_factory=list)
    errors: int = 0
    established_at: float = 0.0
    last_activity: float = 0.0
    state: str = "unknown"

    def __post_init__(self):
        if not self.established_at:
            self.established_at = _time.time()

    def avg_latency(self) -> float:
        if not self.latency_samples:
            return 0
        return sum(self.latency_samples) / len(self.latency_samples)

    def to_dict(self) -> dict:
        return {
            "conn_id": self.conn_id,
            "exit_id": self.exit_id,
            "protocol": self.protocol,
            "bytes_sent": self.bytes_sent,
            "bytes_received": self.bytes_received,
            "total_mb": round((self.bytes_sent + self.bytes_received) / 1_000_000, 3),
            "avg_latency_ms": round(self.avg_latency() * 1000, 2),
            "errors": self.errors,
            "age_sec": round(_time.time() - self.established_at, 1),
            "state": self.state
        }


class MetricsRegistry:
    """Central metrics collection and reporting."""

    def __init__(self):
        self._counters: Dict[str, Counter] = {}
        self._gauges: Dict[str, Gauge] = {}
        self._histograms: Dict[str, Histogram] = {}
        self._conn_metrics: Dict[str, ConnectionMetrics] = {}
        self._lock = threading.Lock()
        self._started_at = _time.time()

        # Pre-register standard metrics
        self.register_counter("vpn_connections_total", {"type": "all"})
        self.register_counter("vpn_bytes_sent_total", {"direction": "sent"})
        self.register_counter("vpn_bytes_received_total", {"direction": "received"})
        self.register_counter("vpn_errors_total", {"type": "all"})
        self.register_gauge("vpn_active_connections", 0.0)
        self.register_gauge("vpn_bandwidth_mbps", 0.0)
        self.register_histogram("vpn_latency_seconds")
        self.register_histogram("vpn_throughput_bytes")

    def register_counter(self, name: str, labels: Optional[Dict[str, str]] = None) -> Counter:
        with self._lock:
            c = Counter(name=name, labels=labels or {})
            self._counters[name] = c
            return c

    def register_gauge(self, name: str, initial: float = 0.0,
                       labels: Optional[Dict[str, str]] = None) -> Gauge:
        with self._lock:
            g = Gauge(name=name, value=initial, labels=labels or {})
            self._gauges[name] = g
            return g

    def register_histogram(self, name: str, labels: Optional[Dict[str, str]] = None) -> Histogram:
        with self._lock:
            h = Histogram(name=name, labels=labels or {})
            self._histograms[name] = h
            return h

    def counter_inc(self, name: str, amount: int = 1):
        with self._lock:
            if name in self._counters:
                self._counters[name].inc(amount)

    def gauge_set(self, name: str, value: float):
        with self._lock:
            if name in self._gauges:
                self._gauges[name].set(value)

    def histogram_observe(self, name: str, value: float):
        with self._lock:
            if name in self._histograms:
                self._histograms[name].observe(value)

    def record_connection(self, conn_id: str, exit_id: str,
                          protocol: str = "tcp") -> ConnectionMetrics:
        with self._lock:
            cm = ConnectionMetrics(conn_id=conn_id, exit_id=exit_id,
                                   protocol=protocol, state="established")
            self._conn_metrics[conn_id] = cm
            self.counter_inc("vpn_connections_total")
            self.gauge_set("vpn_active_connections",
                          len([c for c in self._conn_metrics.values()
                               if c.state == "established"]))
            return cm

    def record_traffic(self, conn_id: str, bytes_sent: int = 0,
                       bytes_received: int = 0, latency_sec: float = 0.0):
        with self._lock:
            if conn_id in self._conn_metrics:
                cm = self._conn_metrics[conn_id]
                cm.bytes_sent += bytes_sent
                cm.bytes_received += bytes_received
                cm.last_activity = _time.time()
                if latency_sec > 0:
                    cm.latency_samples.append(latency_sec)
                    self.histogram_observe("vpn_latency_seconds", latency_sec)
                self.counter_inc("vpn_bytes_sent_total", bytes_sent)
                self.counter_inc("vpn_bytes_received_total", bytes_received)
                throughput = bytes_sent + bytes_received
                if throughput > 0:
                    self.histogram_observe("vpn_throughput_bytes", throughput)

    def record_error(self, conn_id: str):
        with self._lock:
            self.counter_inc("vpn_errors_total")
            if conn_id in self._conn_metrics:
                self._conn_metrics[conn_id].errors += 1

    def close_connection(self, conn_id: str):
        with self._lock:
            if conn_id in self._conn_metrics:
                self._conn_metrics[conn_id].state = "closed"
            self.gauge_set("vpn_active_connections",
                          len([c for c in self._conn_metrics.values()
                               if c.state == "established"]))

    def get_metrics(self) -> dict:
        with self._lock:
            active = len([c for c in self._conn_metrics.values()
                         if c.state == "established"])
            total_bytes_sent = self._counters.get("vpn_bytes_sent_total",
                                                   Counter("")).value
            total_bytes_recv = self._counters.get("vpn_bytes_received_total",
                                                   Counter("")).value
            return {
                "uptime_sec": round(_time.time() - self._started_at, 1),
                "counters": {n: c.to_dict() for n, c in self._counters.items()},
                "gauges": {n: g.to_dict() for n, g in self._gauges.items()},
                "histograms": {n: h.to_dict() for n, h in self._histograms.items()},
                "connections": {
                    "active": active,
                    "total_tracked": len(self._conn_metrics),
                    "total_bytes_sent": total_bytes_sent,
                    "total_bytes_received": total_bytes_recv,
                    "total_mb": round((total_bytes_sent + total_bytes_recv) / 1_000_000, 2)
                }
            }

    def get_connection_metrics(self, conn_id: str) -> dict:
        with self._lock:
            if conn_id not in self._conn_metrics:
                return {"error": f"Connection '{conn_id}' not found"}
            return {"connection": self._conn_metrics[conn_id].to_dict()}

    def get_top_connections(self, limit: int = 10) -> dict:
        with self._lock:
            conns = sorted(self._conn_metrics.values(),
                          key=lambda c: c.bytes_sent + c.bytes_received,
                          reverse=True)
            return {"connections": [c.to_dict() for c in conns[:limit]]}


_metrics = MetricsRegistry()


# Public API
def record_connection_open(conn_id: str, exit_id: str,
                           protocol: str = "tcp") -> dict:
    cm = _metrics.record_connection(conn_id, exit_id, protocol)
    return {"status": "recorded", "connection": cm.to_dict()}


def record_traffic_metrics(conn_id: str, bytes_sent: int = 0,
                           bytes_received: int = 0,
                           latency_sec: float = 0.0) -> dict:
    _metrics.record_traffic(conn_id, bytes_sent, bytes_received, latency_sec)
    return {"status": "recorded"}


def record_error_metric(conn_id: str) -> dict:
    _metrics.record_error(conn_id)
    return {"status": "recorded"}


def record_connection_close(conn_id: str) -> dict:
    _metrics.close_connection(conn_id)
    return {"status": "closed"}


def get_all_metrics() -> dict:
    return _metrics.get_metrics()


def get_connection_metric(conn_id: str) -> dict:
    return _metrics.get_connection_metrics(conn_id)


def get_top_connection_metrics(limit: int = 10) -> dict:
    return _metrics.get_top_connections(limit)


def increment_counter(name: str, amount: int = 1) -> dict:
    _metrics.counter_inc(name, amount)
    return {"status": "incremented", "name": name, "amount": amount}


def set_gauge(name: str, value: float) -> dict:
    _metrics.gauge_set(name, value)
    return {"status": "set", "name": name, "value": value}


def observe_histogram(name: str, value: float) -> dict:
    _metrics.histogram_observe(name, value)
    return {"status": "observed", "name": name, "value": value}
