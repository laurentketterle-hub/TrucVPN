"""
Health Check Module - system health monitoring and status reporting.
Provides health checks for exits, connections, and system resources.
"""
from dataclasses import dataclass, field
from typing import Optional, Dict, List, Any
import time as _time
import threading


@dataclass
class HealthStatus:
    """Status of a health check."""
    component: str = ""
    status: str = "unknown"
    message: str = ""
    checked_at: float = 0.0
    response_time_ms: float = 0.0
    error: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)

    def __post_init__(self):
        if not self.checked_at:
            self.checked_at = _time.time()

    def is_healthy(self) -> bool:
        return self.status == "healthy"

    def to_dict(self) -> dict:
        return {
            "component": self.component,
            "status": self.status,
            "message": self.message,
            "response_time_ms": self.response_time_ms,
            "error": self.error,
            "checked_at": self.checked_at,
            "metadata": self.metadata
        }


@dataclass
class SystemHealth:
    """Aggregate system health report."""
    overall: str = "unknown"
    checks: List[HealthStatus] = field(default_factory=list)
    timestamp: float = 0.0
    hostname: str = ""
    version: str = "1.0.0"
    uptime_sec: float = 0.0

    def __post_init__(self):
        if not self.timestamp:
            self.timestamp = _time.time()

    def to_dict(self) -> dict:
        return {
            "overall": self.overall,
            "timestamp": self.timestamp,
            "hostname": self.hostname,
            "version": self.version,
            "uptime_sec": self.uptime_sec,
            "checks": [c.to_dict() for c in self.checks],
            "summary": {
                "total": len(self.checks),
                "healthy": sum(1 for c in self.checks if c.is_healthy()),
                "unhealthy": sum(1 for c in self.checks if c.status == "unhealthy"),
                "degraded": sum(1 for c in self.checks if c.status == "degraded")
            }
        }


class HealthChecker:
    """Runs health checks and aggregates system health."""

    def __init__(self):
        self._checks: Dict[str, HealthStatus] = {}
        self._lock = threading.Lock()
        self._started_at = _time.time()
        self._check_fns: Dict[str, callable] = {}

    def register_check(self, component: str, check_fn: callable) -> dict:
        with self._lock:
            self._check_fns[component] = check_fn
            return {"status": "registered", "component": component}

    def run_check(self, component: str) -> dict:
        with self._lock:
            start = _time.time()
            if component not in self._check_fns:
                status = HealthStatus(
                    component=component, status="unknown",
                    message="No check registered", error="check_not_found"
                )
            else:
                try:
                    result = self._check_fns[component]()
                    if isinstance(result, dict):
                        status = HealthStatus(
                            component=component,
                            status=result.get("status", "healthy"),
                            message=result.get("message", ""),
                            error=result.get("error"),
                            metadata=result.get("metadata", {})
                        )
                    else:
                        status = HealthStatus(
                            component=component, status="healthy",
                            message=str(result)
                        )
                except Exception as e:
                    status = HealthStatus(
                        component=component, status="unhealthy",
                        message="Check failed", error=str(e)
                    )
            status.response_time_ms = round((_time.time() - start) * 1000, 2)
            self._checks[component] = status
            return {"check": status.to_dict()}

    def run_all_checks(self) -> dict:
        with self._lock:
            for component in self._check_fns:
                self.run_check(component)
            return self.get_health()

    def get_health(self) -> dict:
        with self._lock:
            checks = list(self._checks.values())
            unhealthy = [c for c in checks if c.status == "unhealthy"]
            degraded = [c for c in checks if c.status == "degraded"]

            if unhealthy:
                overall = "unhealthy"
            elif degraded:
                overall = "degraded"
            elif checks:
                overall = "healthy"
            else:
                overall = "unknown"

            return SystemHealth(
                overall=overall, checks=checks,
                uptime_sec=_time.time() - self._started_at,
                hostname="vpn-gateway"
            ).to_dict()

    def get_component_status(self, component: str) -> dict:
        with self._lock:
            if component in self._checks:
                return {"component": self._checks[component].to_dict()}
            return {"error": f"Component '{component}' not found"}

    def check_exit_connectivity(self, exit_id: str, address: str = "",
                                 port: int = 1080) -> dict:
        """Mock exit connectivity check."""
        return {
            "status": "healthy",
            "message": f"Exit {exit_id} reachable",
            "metadata": {"exit_id": exit_id, "address": address, "port": port}
        }

    def check_system_resources(self) -> dict:
        """Mock system resource check."""
        return {
            "status": "healthy",
            "message": "System resources OK",
            "metadata": {
                "cpu_pct": 23.5,
                "memory_mb": 512,
                "disk_free_gb": 50.2,
                "open_fds": 128
            }
        }


_health = HealthChecker()
_health.register_check("system", _health.check_system_resources)
_health.register_check("connectivity", lambda: {"status": "healthy", "message": "Network OK"})
_health.register_check("crypto", lambda: {"status": "healthy", "message": "Crypto engine OK"})
_health.register_check("relay", lambda: {"status": "healthy", "message": "Relay engine OK"})


def register_health_check(component: str, check_fn: callable) -> dict:
    return _health.register_check(component, check_fn)


def run_component_check(component: str) -> dict:
    return _health.run_check(component)


def run_all_health_checks() -> dict:
    return _health.run_all_checks()


def get_system_health() -> dict:
    return _health.get_health()


def get_component_health(component: str) -> dict:
    return _health.get_component_status(component)


def check_exit_health(exit_id: str, address: str = "", port: int = 1080) -> dict:
    return _health.run_check(f"exit-{exit_id}")
