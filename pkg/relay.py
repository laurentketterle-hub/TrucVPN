"""
Relay & Multiplexing Module - connection multiplexing and relay management.
Handles connection forwarding, data relay, and protocol negotiation.
"""
from dataclasses import dataclass, field
from typing import Optional, Dict, List, Tuple
import time as _time
import threading
import secrets


@dataclass
class RelaySession:
    session_id: str = ""
    exit_id: str = ""
    protocol: str = "tcp"
    bytes_upstream: int = 0
    bytes_downstream: int = 0
    created_at: float = 0.0
    last_activity: float = 0.0
    state: str = "active"
    upstream_queue_size: int = 0
    downstream_queue_size: int = 0
    max_queue_size: int = 10000
    metadata: Dict[str, str] = field(default_factory=dict)

    def __post_init__(self):
        if not self.session_id:
            self.session_id = "relay-" + secrets.token_hex(8)
        if not self.created_at:
            self.created_at = _time.time()

    def to_dict(self) -> dict:
        total_mb = round((self.bytes_upstream + self.bytes_downstream) / 1_000_000, 3)
        return {
            "session_id": self.session_id,
            "exit_id": self.exit_id,
            "protocol": self.protocol,
            "bytes_upstream": self.bytes_upstream,
            "bytes_downstream": self.bytes_downstream,
            "total_mb": total_mb,
            "age_sec": round(_time.time() - self.created_at, 1),
            "state": self.state,
        }


@dataclass
class RelayStats:
    total_sessions: int = 0
    active_sessions: int = 0
    total_upstream_bytes: int = 0
    total_downstream_bytes: int = 0
    peak_concurrent: int = 0
    sessions_per_second: float = 0.0
    error_count: int = 0

    def to_dict(self) -> dict:
        total_gb = round((self.total_upstream_bytes + self.total_downstream_bytes) / 1_000_000_000, 3)
        return {
            "total_sessions": self.total_sessions,
            "active_sessions": self.active_sessions,
            "peak_concurrent": self.peak_concurrent,
            "total_gb": total_gb,
            "sessions_per_second": round(self.sessions_per_second, 2),
            "error_count": self.error_count
        }


@dataclass
class ProtocolNegotiation:
    requested_protocols: List[str] = field(default_factory=list)
    selected_protocol: str = ""
    features: List[str] = field(default_factory=list)
    max_packet_size: int = 65536
    compression: str = "none"
    encryption: str = "none"
    negotiated: bool = False

    def to_dict(self) -> dict:
        return {
            "requested": self.requested_protocols,
            "selected": self.selected_protocol,
            "features": self.features,
            "max_packet_size": self.max_packet_size,
            "compression": self.compression,
            "encryption": self.encryption,
            "negotiated": self.negotiated
        }


class RelayManager:
    def __init__(self):
        self._sessions: Dict[str, RelaySession] = {}
        self._stats = RelayStats()
        self._lock = threading.Lock()
        self._started_at = _time.time()
        self._supported_protocols = ["tcp", "udp", "socks5", "http", "https"]
        self._supported_features = ["compression", "encryption", "multiplexing"]

    def create_session(self, exit_id: str, protocol: str = "tcp",
                       metadata: Optional[Dict[str, str]] = None) -> dict:
        with self._lock:
            session = RelaySession(exit_id=exit_id, protocol=protocol,
                                   metadata=metadata or {})
            self._sessions[session.session_id] = session
            self._stats.total_sessions += 1
            self._stats.active_sessions = sum(
                1 for s in self._sessions.values() if s.state == "active")
            self._stats.peak_concurrent = max(
                self._stats.peak_concurrent, self._stats.active_sessions)
            elapsed = max(1, _time.time() - self._started_at)
            self._stats.sessions_per_second = self._stats.total_sessions / elapsed
            return {"status": "created", "session": session.to_dict()}

    def relay_data(self, session_id: str, data_size: int,
                   direction: str = "upstream") -> dict:
        with self._lock:
            if session_id not in self._sessions:
                return {"error": f"Session '{session_id}' not found"}
            session = self._sessions[session_id]
            if session.state != "active":
                return {"error": f"Session is {session.state}"}
            if direction == "upstream":
                session.bytes_upstream += data_size
                self._stats.total_upstream_bytes += data_size
            else:
                session.bytes_downstream += data_size
                self._stats.total_downstream_bytes += data_size
            session.last_activity = _time.time()
            return {"status": "relayed", "session": session.to_dict()}

    def close_session(self, session_id: str) -> dict:
        with self._lock:
            if session_id not in self._sessions:
                return {"error": f"Session '{session_id}' not found"}
            self._sessions[session_id].state = "closed"
            self._stats.active_sessions = sum(
                1 for s in self._sessions.values() if s.state == "active")
            return {"status": "closed", "session": self._sessions[session_id].to_dict()}

    def negotiate_protocol(self, requested: List[str]) -> dict:
        available = [p for p in requested if p in self._supported_protocols]
        if not available:
            return {"negotiated": False, "error": "No compatible protocol"}
        selected = available[0]
        negotiation = ProtocolNegotiation(
            requested_protocols=requested,
            selected_protocol=selected,
            features=self._supported_features.copy(),
            negotiated=True
        )
        return {"negotiation": negotiation.to_dict()}

    def get_relay_stats(self) -> dict:
        with self._lock:
            self._stats.active_sessions = sum(
                1 for s in self._sessions.values() if s.state == "active")
            elapsed = max(1, _time.time() - self._started_at)
            self._stats.sessions_per_second = self._stats.total_sessions / elapsed
            return self._stats.to_dict()

    def get_session_detail(self, session_id: str) -> dict:
        with self._lock:
            if session_id not in self._sessions:
                return {"error": f"Session '{session_id}' not found"}
            return {"session": self._sessions[session_id].to_dict()}

    def list_active_sessions(self, limit: int = 50) -> dict:
        with self._lock:
            active = [s.to_dict() for s in self._sessions.values()
                     if s.state == "active"]
            active.sort(key=lambda s: s["total_mb"], reverse=True)
            return {"sessions": active[:limit], "count": len(active)}

    def drain_sessions(self, exit_id: str) -> dict:
        with self._lock:
            count = 0
            for s in self._sessions.values():
                if s.exit_id == exit_id and s.state == "active":
                    s.state = "draining"
                    count += 1
            return {"drained": count}


_relay = RelayManager()


def create_relay_session(exit_id: str, protocol: str = "tcp") -> dict:
    return _relay.create_session(exit_id, protocol)


def relay_upstream_data(session_id: str, data_size: int) -> dict:
    return _relay.relay_data(session_id, data_size, "upstream")


def relay_downstream_data(session_id: str, data_size: int) -> dict:
    return _relay.relay_data(session_id, data_size, "downstream")


def close_relay_session(session_id: str) -> dict:
    return _relay.close_session(session_id)


def negotiate_protocols(requested: List[str]) -> dict:
    return _relay.negotiate_protocol(requested)


def get_relay_statistics() -> dict:
    return _relay.get_relay_stats()


def get_relay_session(session_id: str) -> dict:
    return _relay.get_session_detail(session_id)


def list_relay_sessions(limit: int = 50) -> dict:
    return _relay.list_active_sessions(limit)


def drain_exit_sessions(exit_id: str) -> dict:
    return _relay.drain_sessions(exit_id)
