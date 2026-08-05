"""
Exit Node Discovery — find, register, and verify share exit nodes.
Provides peer discovery, registration, and verification for VPN mesh.
"""
from dataclasses import dataclass, field
from typing import Optional, Dict, List, Set
import time as _time
import secrets
import hashlib
import threading


@dataclass
class ExitAdvertisement:
    """Advertisement broadcast by an exit node."""
    exit_id: str
    address: str
    port: int = 1080
    protocol: str = "socks5"
    country: str = "XX"
    region: str = ""
    city: str = ""
    bandwidth_mbps: int = 0
    max_clients: int = 100
    current_clients: int = 0
    uptime_sec: int = 0
    features: List[str] = field(default_factory=list)
    score: float = 0.0
    last_seen: float = 0.0
    signature: str = ""
    ttl_sec: int = 300
    is_verified: bool = False

    def __post_init__(self):
        if not self.last_seen:
            self.last_seen = _time.time()
        if not self.exit_id:
            self.exit_id = "exit-" + secrets.token_hex(6)

    def is_expired(self) -> bool:
        return _time.time() - self.last_seen > self.ttl_sec

    def to_dict(self) -> dict:
        return {
            "exit_id": self.exit_id,
            "address": self.address,
            "port": self.port,
            "protocol": self.protocol,
            "location": {"country": self.country, "region": self.region, "city": self.city},
            "bandwidth": {"mbps": self.bandwidth_mbps},
            "capacity": {"max_clients": self.max_clients, "current_clients": self.current_clients},
            "uptime_sec": self.uptime_sec,
            "features": self.features,
            "score": self.score,
            "last_seen": self.last_seen,
            "is_verified": self.is_verified,
            "is_expired": self.is_expired()
        }


@dataclass
class DiscoveryConfig:
    """Configuration for node discovery."""
    refresh_interval_sec: float = 60.0
    advertisement_ttl_sec: int = 300
    max_peers: int = 100
    min_score_threshold: float = 0.1
    trusted_exits: List[str] = field(default_factory=list)
    blacklist: List[str] = field(default_factory=list)
    auto_verify: bool = False

    def to_dict(self) -> dict:
        return {
            "refresh_interval_sec": self.refresh_interval_sec,
            "advertisement_ttl_sec": self.advertisement_ttl_sec,
            "max_peers": self.max_peers,
            "min_score_threshold": self.min_score_threshold,
            "trusted_exits": self.trusted_exits,
            "blacklist": self.blacklist,
            "auto_verify": self.auto_verify
        }


class ExitDiscovery:
    """Manages exit node discovery and registration."""

    def __init__(self, config: Optional[DiscoveryConfig] = None):
        self.config = config or DiscoveryConfig()
        self._exits: Dict[str, ExitAdvertisement] = {}
        self._lock = threading.Lock()
        self._last_refresh: float = 0.0
        self._stats = {"ads_received": 0, "ads_accepted": 0, "ads_rejected": 0}

    def advertise(self, address: str, port: int = 1080, protocol: str = "socks5",
                  country: str = "XX", bandwidth_mbps: int = 100,
                  max_clients: int = 100, features: Optional[List[str]] = None,
                  signature: str = "") -> dict:
        """Register/publish an exit node advertisement."""
        ad = ExitAdvertisement(
            address=address, port=port, protocol=protocol,
            country=country, bandwidth_mbps=bandwidth_mbps,
            max_clients=max_clients, features=features or [],
            signature=signature
        )
        with self._lock:
            # Check blacklist
            if ad.exit_id in self.config.blacklist:
                return {"error": "Exit is blacklisted"}
            # Check capacity
            if len(self._exits) >= self.config.max_peers:
                # Remove expired entries
                self._cleanup_expired()
                if len(self._exits) >= self.config.max_peers:
                    return {"error": "Max peers reached"}
            
            # Auto-verify trusted exits
            if ad.exit_id in self.config.trusted_exits:
                ad.is_verified = True
            
            self._exits[ad.exit_id] = ad
            self._stats["ads_received"] += 1
            self._stats["ads_accepted"] += 1
        
        return {"status": "advertised", "exit": ad.to_dict()}

    def discover(self, country: Optional[str] = None,
                 min_bandwidth_mbps: int = 0,
                 require_verified: bool = False,
                 limit: int = 20) -> dict:
        """Discover available exit nodes."""
        with self._lock:
            self._cleanup_expired()
            
            exits = list(self._exits.values())
            
            # Filter
            if country:
                exits = [e for e in exits if e.country == country]
            if min_bandwidth_mbps > 0:
                exits = [e for e in exits if e.bandwidth_mbps >= min_bandwidth_mbps]
            if require_verified:
                exits = [e for e in exits if e.is_verified]
            
            # Sort by score (descending)
            exits.sort(key=lambda e: (e.is_verified, e.score, e.bandwidth_mbps), reverse=True)
            
            return {
                "exits": [e.to_dict() for e in exits[:limit]],
                "total_available": len(exits),
                "total_known": len(self._exits)
            }

    def verify_exit(self, exit_id: str) -> dict:
        """Mark an exit as verified."""
        with self._lock:
            if exit_id not in self._exits:
                return {"error": f"Exit '{exit_id}' not found"}
            self._exits[exit_id].is_verified = True
            self._exits[exit_id].score = min(1.0, self._exits[exit_id].score + 0.2)
            return {"status": "verified", "exit": self._exits[exit_id].to_dict()}

    def update_exit_status(self, exit_id: str, current_clients: int = 0,
                           uptime_sec: Optional[int] = None,
                           bandwidth_mbps: Optional[int] = None) -> dict:
        """Update an exit's runtime status."""
        with self._lock:
            if exit_id not in self._exits:
                return {"error": f"Exit '{exit_id}' not found"}
            ad = self._exits[exit_id]
            ad.current_clients = current_clients
            ad.last_seen = _time.time()
            if uptime_sec is not None:
                ad.uptime_sec = uptime_sec
            if bandwidth_mbps is not None:
                ad.bandwidth_mbps = bandwidth_mbps
            # Update score based on uptime
            ad.score = min(1.0, ad.uptime_sec / 86400) * 0.5 + 0.5
            return {"status": "updated", "exit": ad.to_dict()}

    def blacklist_exit(self, exit_id: str, reason: str = "") -> dict:
        """Blacklist an exit node."""
        with self._lock:
            if exit_id not in self.config.blacklist:
                self.config.blacklist.append(exit_id)
            if exit_id in self._exits:
                del self._exits[exit_id]
            return {"status": "blacklisted", "exit_id": exit_id, "reason": reason}

    def get_exit_detail(self, exit_id: str) -> dict:
        """Get detailed info about a specific exit."""
        with self._lock:
            if exit_id not in self._exits:
                return {"error": f"Exit '{exit_id}' not found"}
            return {"exit": self._exits[exit_id].to_dict()}

    def get_discovery_stats(self) -> dict:
        with self._lock:
            online = sum(1 for e in self._exits.values() if not e.is_expired())
            return {
                "total_exits": len(self._exits),
                "online": online,
                "verified": sum(1 for e in self._exits.values() if e.is_verified),
                "blacklisted": len(self.config.blacklist),
                "stats": self._stats.copy()
            }

    def _cleanup_expired(self):
        expired = [eid for eid, e in self._exits.items() if e.is_expired()]
        for eid in expired:
            del self._exits[eid]

    def configure(self, **kwargs) -> dict:
        """Update discovery configuration."""
        changed = {}
        for key, value in kwargs.items():
            if hasattr(self.config, key):
                setattr(self.config, key, value)
                changed[key] = value
        return {"status": "configured", "changes": changed}


_discovery = ExitDiscovery()


# Public API
def advertise_exit(address: str, port: int = 1080, protocol: str = "socks5",
                   country: str = "XX", bandwidth_mbps: int = 100,
                   max_clients: int = 100, features: Optional[List[str]] = None) -> dict:
    return _discovery.advertise(address, port, protocol, country,
                                 bandwidth_mbps, max_clients, features)


def discover_exits(country: Optional[str] = None,
                   min_bandwidth_mbps: int = 0,
                   require_verified: bool = False,
                   limit: int = 20) -> dict:
    return _discovery.discover(country, min_bandwidth_mbps, require_verified, limit)


def verify_exit_node(exit_id: str) -> dict:
    return _discovery.verify_exit(exit_id)


def update_exit_node(exit_id: str, current_clients: int = 0,
                     uptime_sec: Optional[int] = None,
                     bandwidth_mbps: Optional[int] = None) -> dict:
    return _discovery.update_exit_status(exit_id, current_clients, uptime_sec, bandwidth_mbps)


def blacklist_exit_node(exit_id: str, reason: str = "") -> dict:
    return _discovery.blacklist_exit(exit_id, reason)


def get_exit_node_detail(exit_id: str) -> dict:
    return _discovery.get_exit_detail(exit_id)


def get_discovery_stats() -> dict:
    return _discovery.get_discovery_stats()


def configure_discovery(**kwargs) -> dict:
    return _discovery.configure(**kwargs)
