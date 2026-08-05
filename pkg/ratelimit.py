"""
Rate Limiting Module - per-client and global rate limiting with multiple algorithms.
Supports token bucket, sliding window, and fixed window rate limiters.
"""
from dataclasses import dataclass, field
from typing import Optional, Dict, List, Tuple
import time as _time
import threading
import collections


@dataclass
class RateLimitConfig:
    """Configuration for a rate limiter."""
    name: str = ""
    algorithm: str = "token_bucket"
    max_requests: int = 100
    window_sec: float = 60.0
    burst_size: int = 10
    per_client: bool = True
    block_duration_sec: float = 300.0
    enabled: bool = True

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "algorithm": self.algorithm,
            "max_requests": self.max_requests,
            "window_sec": self.window_sec,
            "burst_size": self.burst_size,
            "per_client": self.per_client,
            "block_duration_sec": self.block_duration_sec,
            "enabled": self.enabled
        }


class TokenBucketLimiter:
    """Token bucket rate limiter."""

    def __init__(self, rate: float, burst: int):
        self.rate = rate
        self.burst = burst
        self.tokens = float(burst)
        self.last_refill = _time.time()
        self._lock = threading.Lock()

    def allow(self) -> bool:
        with self._lock:
            now = _time.time()
            elapsed = now - self.last_refill
            self.tokens = min(float(self.burst), self.tokens + elapsed * self.rate)
            self.last_refill = now
            if self.tokens >= 1.0:
                self.tokens -= 1.0
                return True
            return False

    def available(self) -> float:
        with self._lock:
            elapsed = _time.time() - self.last_refill
            return min(float(self.burst), self.tokens + elapsed * self.rate)


class SlidingWindowLimiter:
    """Sliding window rate limiter."""

    def __init__(self, max_requests: int, window_sec: float):
        self.max_requests = max_requests
        self.window_sec = window_sec
        self._timestamps: collections.deque = collections.deque()
        self._lock = threading.Lock()

    def allow(self) -> bool:
        with self._lock:
            now = _time.time()
            cutoff = now - self.window_sec
            while self._timestamps and self._timestamps[0] < cutoff:
                self._timestamps.popleft()
            if len(self._timestamps) < self.max_requests:
                self._timestamps.append(now)
                return True
            return False

    def count(self) -> int:
        with self._lock:
            now = _time.time()
            cutoff = now - self.window_sec
            while self._timestamps and self._timestamps[0] < cutoff:
                self._timestamps.popleft()
            return len(self._timestamps)


class FixedWindowLimiter:
    """Fixed window rate limiter."""

    def __init__(self, max_requests: int, window_sec: float):
        self.max_requests = max_requests
        self.window_sec = window_sec
        self._window_start = _time.time()
        self._count = 0
        self._lock = threading.Lock()

    def allow(self) -> bool:
        with self._lock:
            now = _time.time()
            if now - self._window_start >= self.window_sec:
                self._window_start = now
                self._count = 0
            if self._count < self.max_requests:
                self._count += 1
                return True
            return False

    def remaining(self) -> int:
        with self._lock:
            if _time.time() - self._window_start >= self.window_sec:
                return self.max_requests
            return max(0, self.max_requests - self._count)


class RateLimitManager:
    """Manages rate limiters for multiple clients and resources."""

    def __init__(self):
        self._configs: Dict[str, RateLimitConfig] = {}
        self._limiters: Dict[str, Dict[str, object]] = {}
        self._blocked: Dict[str, float] = {}
        self._violations: Dict[str, int] = {}
        self._lock = threading.Lock()

        self.configure("global", RateLimitConfig(
            name="global", algorithm="token_bucket",
            max_requests=1000, window_sec=1.0, burst_size=100,
            per_client=False
        ))
        self.configure("connections_per_ip", RateLimitConfig(
            name="connections_per_ip", algorithm="sliding_window",
            max_requests=50, window_sec=60.0, burst_size=10
        ))
        self.configure("requests_per_ip", RateLimitConfig(
            name="requests_per_ip", algorithm="token_bucket",
            max_requests=100, window_sec=60.0, burst_size=20
        ))

    def configure(self, name: str, config: RateLimitConfig) -> dict:
        with self._lock:
            self._configs[name] = config
            if name not in self._limiters:
                self._limiters[name] = {}
            return {"status": "configured", "config": config.to_dict()}

    def _get_limiter(self, config: RateLimitConfig, client_id: str = ""):
        key = client_id if config.per_client else "_global"
        if key not in self._limiters[config.name]:
            rate = config.max_requests / config.window_sec
            if config.algorithm == "token_bucket":
                limiter = TokenBucketLimiter(rate, config.burst_size)
            elif config.algorithm == "sliding_window":
                limiter = SlidingWindowLimiter(config.max_requests, config.window_sec)
            elif config.algorithm == "fixed_window":
                limiter = FixedWindowLimiter(config.max_requests, config.window_sec)
            else:
                limiter = TokenBucketLimiter(rate, config.burst_size)
            self._limiters[config.name][key] = limiter
        return self._limiters[config.name][key]

    def check(self, name: str, client_id: str = "") -> dict:
        """Check if a request is allowed."""
        with self._lock:
            if name not in self._configs:
                return {"allowed": False, "error": "Config not found"}
            config = self._configs[name]
            if not config.enabled:
                return {"allowed": True, "reason": "disabled"}

            block_key = f"{name}:{client_id}" if client_id else name
            if block_key in self._blocked:
                if _time.time() < self._blocked[block_key]:
                    return {"allowed": False, "reason": "blocked",
                            "unblock_in_sec": round(self._blocked[block_key] - _time.time(), 1)}
                del self._blocked[block_key]

            limiter = self._get_limiter(config, client_id)
            allowed = limiter.allow()
            if not allowed:
                self._violations[name] = self._violations.get(name, 0) + 1
                if self._violations[name] > config.burst_size * 3:
                    self._blocked[block_key] = _time.time() + config.block_duration_sec
            return {"allowed": allowed, "name": name, "client_id": client_id}

    def get_status(self, name: str = "", client_id: str = "") -> dict:
        with self._lock:
            if name and name in self._configs:
                config = self._configs[name]
                limiter = self._get_limiter(config, client_id)
                remaining = getattr(limiter, 'available', lambda: 0)()
                if hasattr(limiter, 'count'):
                    remaining = max(0, config.max_requests - limiter.count())
                return {
                    "name": name,
                    "client_id": client_id,
                    "remaining": round(remaining, 1),
                    "config": config.to_dict()
                }
            configs = {n: c.to_dict() for n, c in self._configs.items()}
            return {"configs": configs, "violations": self._violations.copy()}

    def reset(self, name: str = "", client_id: str = "") -> dict:
        with self._lock:
            if name:
                if name in self._limiters:
                    if client_id:
                        self._limiters[name].pop(client_id, None)
                    else:
                        self._limiters[name] = {}
                return {"status": "reset", "name": name}
            return {"error": "Name required"}

    def unblock(self, name: str, client_id: str = "") -> dict:
        with self._lock:
            block_key = f"{name}:{client_id}" if client_id else name
            self._blocked.pop(block_key, None)
            return {"status": "unblocked", "name": name, "client_id": client_id}


_rlm = RateLimitManager()


def check_rate_limit(name: str, client_id: str = "") -> dict:
    return _rlm.check(name, client_id)


def configure_rate_limit(name: str, max_requests: int = 100,
                         window_sec: float = 60.0, burst_size: int = 10,
                         algorithm: str = "token_bucket",
                         per_client: bool = True) -> dict:
    config = RateLimitConfig(
        name=name, max_requests=max_requests, window_sec=window_sec,
        burst_size=burst_size, algorithm=algorithm, per_client=per_client
    )
    return _rlm.configure(name, config)


def get_rate_limit_status(name: str = "", client_id: str = "") -> dict:
    return _rlm.get_status(name, client_id)


def reset_rate_limit(name: str, client_id: str = "") -> dict:
    return _rlm.reset(name, client_id)


def unblock_client(name: str, client_id: str = "") -> dict:
    return _rlm.unblock(name, client_id)
