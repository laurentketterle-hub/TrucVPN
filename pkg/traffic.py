"""
Traffic Shaping & QoS Module — bandwidth management, rate limiting, and QoS policies.
"""
from dataclasses import dataclass, field
from typing import Optional, Dict, List
import time as _time
import threading


@dataclass
class TokenBucket:
    rate: float
    burst: float
    tokens: float = 0.0
    last_refill: float = 0.0
    _lock: object = field(default_factory=threading.Lock)

    def __post_init__(self):
        self.tokens = self.burst
        self.last_refill = _time.time()

    def _refill(self):
        now = _time.time()
        elapsed = now - self.last_refill
        self.tokens = min(self.burst, self.tokens + elapsed * self.rate)
        self.last_refill = now

    def consume(self, size: int) -> bool:
        with self._lock:
            self._refill()
            if self.tokens >= size:
                self.tokens -= size
                return True
            return False

    def to_dict(self) -> dict:
        with self._lock:
            self._refill()
            return {"rate_bps": self.rate, "burst_bytes": self.burst,
                    "available_bytes": self.tokens,
                    "utilization_pct": round((1 - self.tokens / self.burst) * 100, 1)}


@dataclass
class QoSPolicy:
    name: str
    priority: int = 0
    min_bandwidth_bps: int = 0
    max_bandwidth_bps: int = 0
    latency_target_ms: int = 0
    dscp_mark: Optional[int] = None

    def to_dict(self) -> dict:
        return {"name": self.name, "priority": self.priority,
                "min_bandwidth_bps": self.min_bandwidth_bps,
                "max_bandwidth_bps": self.max_bandwidth_bps,
                "latency_target_ms": self.latency_target_ms,
                "dscp_mark": self.dscp_mark}


@dataclass
class TrafficRule:
    policy_name: str
    protocol: str = "tcp"
    dst_port: int = 0
    src_port: int = 0
    dst_ip_prefix: str = ""
    dscp: int = -1
    priority: int = 100

    def matches(self, protocol: str, dst_port: int, src_port: int = 0,
                dst_ip: str = "", dscp: int = -1) -> bool:
        if self.protocol != "any" and self.protocol != protocol:
            return False
        if self.dst_port != 0 and self.dst_port != dst_port:
            return False
        if self.src_port != 0 and self.src_port != src_port:
            return False
        if self.dst_ip_prefix and dst_ip and not dst_ip.startswith(self.dst_ip_prefix):
            return False
        if self.dscp != -1 and dscp != -1 and self.dscp != dscp:
            return False
        return True

    def to_dict(self) -> dict:
        return {"policy_name": self.policy_name, "protocol": self.protocol,
                "dst_port": self.dst_port, "src_port": self.src_port,
                "dst_ip_prefix": self.dst_ip_prefix, "dscp": self.dscp,
                "priority": self.priority}


class BandwidthManager:
    def __init__(self):
        self._policies: Dict[str, QoSPolicy] = {}
        self._rules: List[TrafficRule] = []
        self._buckets: Dict[str, TokenBucket] = {}
        self._lock = threading.Lock()
        self.add_policy(QoSPolicy("default", priority=0))
        self.add_policy(QoSPolicy("realtime", priority=2, min_bandwidth_bps=1000000,
                                   latency_target_ms=50, dscp_mark=46))
        self.add_policy(QoSPolicy("bulk", priority=0, max_bandwidth_bps=5000000))

    def add_policy(self, policy: QoSPolicy):
        with self._lock:
            self._policies[policy.name] = policy
            if policy.max_bandwidth_bps > 0:
                self._buckets[policy.name] = TokenBucket(
                    rate=policy.max_bandwidth_bps, burst=policy.max_bandwidth_bps * 2)

    def add_rule(self, rule: TrafficRule):
        with self._lock:
            self._rules.append(rule)
            self._rules.sort(key=lambda r: r.priority)

    def classify(self, protocol: str, dst_port: int, src_port: int = 0,
                 dst_ip: str = "", dscp: int = -1) -> str:
        for rule in self._rules:
            if rule.matches(protocol, dst_port, src_port, dst_ip, dscp):
                return rule.policy_name
        return "default"

    def allow_traffic(self, policy_name: str, size: int) -> bool:
        bucket = self._buckets.get(policy_name)
        if bucket is None:
            return True
        return bucket.consume(size)

    def get_stats(self) -> dict:
        result = {"policies": {}, "total_rules": len(self._rules)}
        for name, policy in self._policies.items():
            bucket = self._buckets.get(name)
            result["policies"][name] = {
                "priority": policy.priority,
                "min_bps": policy.min_bandwidth_bps,
                "max_bps": policy.max_bandwidth_bps,
                "bucket": bucket.to_dict() if bucket else None
            }
        return result

    def list_policies(self) -> List[dict]:
        return [p.to_dict() for p in self._policies.values()]

    def list_rules(self) -> List[dict]:
        return [r.to_dict() for r in self._rules.values()]


_mgr = BandwidthManager()


def configure_policy(name: str, priority: int = 0,
                     max_bandwidth_bps: int = 0,
                     min_bandwidth_bps: int = 0,
                     latency_target_ms: int = 0,
                     dscp_mark: Optional[int] = None) -> dict:
    policy = QoSPolicy(name=name, priority=priority,
                       min_bandwidth_bps=min_bandwidth_bps,
                       max_bandwidth_bps=max_bandwidth_bps,
                       latency_target_ms=latency_target_ms,
                       dscp_mark=dscp_mark)
    _mgr.add_policy(policy)
    return {"status": "ok", "policy": policy.to_dict()}


def add_traffic_rule(policy_name: str, protocol: str = "tcp",
                     dst_port: int = 0, src_port: int = 0,
                     dst_ip_prefix: str = "", dscp: int = -1,
                     priority: int = 100) -> dict:
    rule = TrafficRule(policy_name=policy_name, protocol=protocol,
                       dst_port=dst_port, src_port=src_port,
                       dst_ip_prefix=dst_ip_prefix, dscp=dscp, priority=priority)
    _mgr.add_rule(rule)
    return {"status": "ok", "rule": rule.to_dict()}


def check_traffic(protocol: str, dst_port: int, size: int,
                  src_port: int = 0, dst_ip: str = "") -> dict:
    policy_name = _mgr.classify(protocol, dst_port, src_port, dst_ip)
    allowed = _mgr.allow_traffic(policy_name, size)
    return {"classified_as": policy_name, "allowed": allowed,
            "size": size, "protocol": protocol, "dst_port": dst_port}


def get_qos_stats() -> dict:
    return _mgr.get_stats()


def list_qos_policies() -> dict:
    return {"policies": _mgr.list_policies()}


def list_traffic_rules() -> dict:
    return {"rules": _mgr.list_rules()}


@dataclass
class ExitStats:
    exit_id: str
    bytes_sent: int = 0
    bytes_received: int = 0
    active_connections: int = 0
    last_active: float = 0.0

    def to_dict(self) -> dict:
        return {
            "exit_id": self.exit_id,
            "bytes_sent": self.bytes_sent,
            "bytes_received": self.bytes_received,
            "active_connections": self.active_connections,
            "last_active": self.last_active,
            "total_mb": round((self.bytes_sent + self.bytes_received) / 1_000_000, 2)
        }


_exit_stats: Dict[str, ExitStats] = {}


def record_exit_traffic(exit_id: str, bytes_sent: int = 0, bytes_received: int = 0) -> dict:
    if exit_id not in _exit_stats:
        _exit_stats[exit_id] = ExitStats(exit_id=exit_id)
    stats = _exit_stats[exit_id]
    stats.bytes_sent += bytes_sent
    stats.bytes_received += bytes_received
    stats.last_active = _time.time()
    return stats.to_dict()


def get_exit_stats(exit_id: Optional[str] = None) -> dict:
    if exit_id:
        s = _exit_stats.get(exit_id)
        return {"exit_id": exit_id, "stats": s.to_dict()} if s else {"error": f"Exit '{exit_id}' not found"}
    return {"exits": {eid: s.to_dict() for eid, s in _exit_stats.items()}}


def get_load_ranking() -> dict:
    if not _exit_stats:
        return {"exits": [], "message": "No exit data available"}
    ranked = sorted(_exit_stats.values(),
                    key=lambda s: (s.active_connections, s.bytes_sent + s.bytes_received))
    return {"exits": [s.to_dict() for s in ranked]}
