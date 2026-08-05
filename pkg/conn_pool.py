"""
Connection Pool — manage and multiplex connections across exit nodes.
Provides connection pooling, multiplexing, and health checking.
"""
from dataclasses import dataclass, field
from typing import Optional, Dict, List, Set
import time as _time
import threading
import random


@dataclass
class Connection:
    """A single proxied connection."""
    conn_id: str
    exit_id: str
    created_at: float = 0.0
    last_activity: float = 0.0
    bytes_sent: int = 0
    bytes_received: int = 0
    protocol: str = "tcp"
    dst_host: str = ""
    dst_port: int = 0
    state: str = "active"  # active, idle, closing, closed

    def to_dict(self) -> dict:
        return {
            "conn_id": self.conn_id,
            "exit_id": self.exit_id,
            "age_sec": round(_time.time() - self.created_at, 1),
            "idle_sec": round(_time.time() - self.last_activity, 1),
            "bytes_sent": self.bytes_sent,
            "bytes_received": self.bytes_received,
            "protocol": self.protocol,
            "dst": f"{self.dst_host}:{self.dst_port}",
            "state": self.state
        }


@dataclass
class ExitNode:
    """Represents a share exit node."""
    exit_id: str
    address: str = ""
    port: int = 1080
    max_connections: int = 100
    active_connections: int = 0
    health_score: float = 1.0
    latency_ms: float = 0.0
    last_health_check: float = 0.0
    total_bytes: int = 0
    is_available: bool = True

    def to_dict(self) -> dict:
        return {
            "exit_id": self.exit_id,
            "address": f"{self.address}:{self.port}",
            "max_connections": self.max_connections,
            "active_connections": self.active_connections,
            "health_score": self.health_score,
            "latency_ms": self.latency_ms,
            "total_bytes": self.total_bytes,
            "available": self.is_available,
            "load_pct": round(self.active_connections / self.max_connections * 100, 1)
            if self.max_connections > 0 else 0
        }


class ConnectionPool:
    """Manages a pool of connections across exit nodes."""

    def __init__(self):
        self._exits: Dict[str, ExitNode] = {}
        self._connections: Dict[str, Connection] = {}
        self._lock = threading.Lock()
        self._conn_counter = 0

    def register_exit(self, exit_id: str, address: str = "", port: int = 1080,
                      max_connections: int = 100) -> dict:
        with self._lock:
            if exit_id in self._exits:
                return {"error": f"Exit '{exit_id}' already registered"}
            self._exits[exit_id] = ExitNode(
                exit_id=exit_id, address=address, port=port,
                max_connections=max_connections
            )
            return {"status": "registered", "exit": self._exits[exit_id].to_dict()}

    def unregister_exit(self, exit_id: str) -> dict:
        with self._lock:
            if exit_id not in self._exits:
                return {"error": f"Exit '{exit_id}' not found"}
            # Close all connections on this exit
            to_close = [c for c in self._connections.values() if c.exit_id == exit_id]
            for c in to_close:
                c.state = "closed"
                del self._connections[c.conn_id]
            del self._exits[exit_id]
            return {"status": "unregistered", "connections_closed": len(to_close)}

    def acquire_connection(self, exit_id: str, protocol: str = "tcp",
                           dst_host: str = "", dst_port: int = 0) -> dict:
        with self._lock:
            if exit_id not in self._exits:
                return {"error": f"Exit '{exit_id}' not registered"}
            exit_node = self._exits[exit_id]
            if not exit_node.is_available:
                return {"error": f"Exit '{exit_id}' is unavailable"}
            if exit_node.active_connections >= exit_node.max_connections:
                return {"error": "Exit at max connections"}

            self._conn_counter += 1
            conn_id = f"conn-{self._conn_counter:06d}"
            now = _time.time()
            conn = Connection(
                conn_id=conn_id, exit_id=exit_id,
                created_at=now, last_activity=now,
                protocol=protocol, dst_host=dst_host, dst_port=dst_port
            )
            self._connections[conn_id] = conn
            exit_node.active_connections += 1
            return {"status": "connected", "connection": conn.to_dict()}

    def release_connection(self, conn_id: str) -> dict:
        with self._lock:
            if conn_id not in self._connections:
                return {"error": f"Connection '{conn_id}' not found"}
            conn = self._connections[conn_id]
            exit_id = conn.exit_id
            del self._connections[conn_id]
            if exit_id in self._exits:
                self._exits[exit_id].active_connections -= 1
            return {"status": "released", "conn_id": conn_id}

    def select_best_exit(self, protocol: str = "tcp",
                         prefer_low_latency: bool = True) -> Optional[str]:
        """Select the best exit node for a new connection."""
        with self._lock:
            candidates = [e for e in self._exits.values()
                         if e.is_available and e.active_connections < e.max_connections]
            if not candidates:
                return None
            if prefer_low_latency:
                candidates.sort(key=lambda e: (e.latency_ms, e.active_connections))
            else:
                candidates.sort(key=lambda e: e.active_connections)
            return candidates[0].exit_id

    def update_health(self, exit_id: str, latency_ms: float,
                      is_available: bool = True) -> dict:
        with self._lock:
            if exit_id not in self._exits:
                return {"error": f"Exit '{exit_id}' not found"}
            exit_node = self._exits[exit_id]
            exit_node.latency_ms = latency_ms
            exit_node.is_available = is_available
            exit_node.last_health_check = _time.time()
            exit_node.health_score = max(0.0, 1.0 - latency_ms / 1000.0)
            return {"status": "updated", "exit": exit_node.to_dict()}

    def record_traffic(self, conn_id: str, bytes_sent: int = 0,
                       bytes_received: int = 0) -> dict:
        with self._lock:
            if conn_id not in self._connections:
                return {"error": f"Connection '{conn_id}' not found"}
            conn = self._connections[conn_id]
            conn.bytes_sent += bytes_sent
            conn.bytes_received += bytes_received
            conn.last_activity = _time.time()
            if conn.exit_id in self._exits:
                self._exits[conn.exit_id].total_bytes += bytes_sent + bytes_received
            return {"status": "recorded", "connection": conn.to_dict()}

    def get_pool_stats(self) -> dict:
        with self._lock:
            total_conns = len(self._connections)
            total_bytes = sum(c.bytes_sent + c.bytes_received
                            for c in self._connections.values())
            exits_stats = [e.to_dict() for e in self._exits.values()]
            return {
                "total_connections": total_conns,
                "total_bytes": total_bytes,
                "total_exits": len(self._exits),
                "exits": exits_stats,
                "connections": [c.to_dict() for c in
                               sorted(self._connections.values(),
                                      key=lambda c: c.last_activity, reverse=True)[:20]]
            }

    def list_connections(self, exit_id: Optional[str] = None) -> dict:
        with self._lock:
            if exit_id:
                conns = [c.to_dict() for c in self._connections.values()
                        if c.exit_id == exit_id]
            else:
                conns = [c.to_dict() for c in self._connections.values()]
            return {"connections": conns, "count": len(conns)}

    def close_idle(self, idle_sec: float = 300.0) -> dict:
        """Close connections idle longer than `idle_sec`."""
        with self._lock:
            now = _time.time()
            to_close = [cid for cid, c in self._connections.items()
                       if now - c.last_activity > idle_sec]
            for cid in to_close:
                conn = self._connections[cid]
                if conn.exit_id in self._exits:
                    self._exits[conn.exit_id].active_connections -= 1
                del self._connections[cid]
            return {"closed": len(to_close), "remaining": len(self._connections)}


_pool = ConnectionPool()


# Public API
def register_exit(exit_id: str, address: str = "", port: int = 1080,
                  max_connections: int = 100) -> dict:
    return _pool.register_exit(exit_id, address, port, max_connections)


def unregister_exit(exit_id: str) -> dict:
    return _pool.unregister_exit(exit_id)


def connect_to_exit(exit_id: str, protocol: str = "tcp",
                    dst_host: str = "", dst_port: int = 0) -> dict:
    if not exit_id:
        exit_id = _pool.select_best_exit(protocol)
        if not exit_id:
            return {"error": "No available exits"}
    return _pool.acquire_connection(exit_id, protocol, dst_host, dst_port)


def disconnect(conn_id: str) -> dict:
    return _pool.release_connection(conn_id)


def smart_connect(protocol: str = "tcp", dst_host: str = "",
                  dst_port: int = 0, prefer_low_latency: bool = True) -> dict:
    exit_id = _pool.select_best_exit(protocol, prefer_low_latency)
    if not exit_id:
        return {"error": "No available exits"}
    return _pool.acquire_connection(exit_id, protocol, dst_host, dst_port)


def update_exit_health(exit_id: str, latency_ms: float,
                       is_available: bool = True) -> dict:
    return _pool.update_health(exit_id, latency_ms, is_available)


def record_connection_traffic(conn_id: str, bytes_sent: int = 0,
                              bytes_received: int = 0) -> dict:
    return _pool.record_traffic(conn_id, bytes_sent, bytes_received)


def get_pool_status() -> dict:
    return _pool.get_pool_stats()


def list_pool_connections(exit_id: Optional[str] = None) -> dict:
    return _pool.list_connections(exit_id)


def cleanup_idle_connections(idle_sec: float = 300.0) -> dict:
    return _pool.close_idle(idle_sec)
