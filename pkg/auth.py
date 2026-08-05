"""
Authentication & Authorization - client auth, token management, access control.
Handles user authentication, session tokens, and per-exit authorization.
"""
from dataclasses import dataclass, field
from typing import Optional, Dict, List, Set
import time as _time
import secrets
import hashlib
import hmac
import base64
import threading


@dataclass
class AuthToken:
    token_id: str = ""
    user_id: str = ""
    issued_at: float = 0.0
    expires_at: float = 0.0
    scopes: List[str] = field(default_factory=list)
    exit_restrictions: List[str] = field(default_factory=list)
    ip_bound: Optional[str] = None
    is_revoked: bool = False
    metadata: Dict[str, str] = field(default_factory=dict)

    def __post_init__(self):
        if not self.token_id:
            self.token_id = "tok-" + secrets.token_hex(16)
        if not self.issued_at:
            self.issued_at = _time.time()
        if not self.expires_at:
            self.expires_at = self.issued_at + 3600

    def is_valid(self, client_ip: Optional[str] = None) -> bool:
        if self.is_revoked:
            return False
        if _time.time() > self.expires_at:
            return False
        if self.ip_bound and client_ip and self.ip_bound != client_ip:
            return False
        return True

    def has_scope(self, scope: str) -> bool:
        return scope in self.scopes or "*" in self.scopes

    def to_dict(self) -> dict:
        return {
            "token_id": self.token_id,
            "user_id": self.user_id,
            "scopes": self.scopes,
            "expires_in_sec": max(0, int(self.expires_at - _time.time())),
            "is_valid": self.is_valid()
        }


@dataclass
class UserAccount:
    user_id: str
    username: str = ""
    password_hash: str = ""
    salt: str = ""
    roles: List[str] = field(default_factory=lambda: ["user"])
    created_at: float = 0.0
    last_login: float = 0.0
    is_active: bool = True
    max_sessions: int = 5
    bandwidth_limit_bps: int = 0
    allowed_exits: List[str] = field(default_factory=list)

    def __post_init__(self):
        if not self.created_at:
            self.created_at = _time.time()
        if not self.salt:
            self.salt = secrets.token_hex(16)

    def to_dict(self) -> dict:
        return {
            "user_id": self.user_id,
            "username": self.username,
            "roles": self.roles,
            "is_active": self.is_active,
            "max_sessions": self.max_sessions,
            "bandwidth_limit_bps": self.bandwidth_limit_bps,
            "allowed_exits": self.allowed_exits
        }


@dataclass
class AccessRule:
    rule_id: str = ""
    resource: str = ""
    action: str = "connect"
    subject: str = "*"
    effect: str = "allow"
    priority: int = 0
    conditions: Dict[str, str] = field(default_factory=dict)

    def __post_init__(self):
        if not self.rule_id:
            self.rule_id = "rule-" + secrets.token_hex(6)

    def matches(self, user_id: str, roles: List[str], resource: str, action: str) -> bool:
        if self.resource != "*" and self.resource != resource:
            return False
        if self.action != "*" and self.action != action:
            return False
        if self.subject == "*":
            return True
        if self.subject == user_id:
            return True
        if self.subject in roles:
            return True
        return False

    def to_dict(self) -> dict:
        return {
            "rule_id": self.rule_id,
            "resource": self.resource,
            "action": self.action,
            "subject": self.subject,
            "effect": self.effect,
            "priority": self.priority
        }


class AuthManager:
    def __init__(self):
        self._users: Dict[str, UserAccount] = {}
        self._tokens: Dict[str, AuthToken] = {}
        self._access_rules: List[AccessRule] = []
        self._lock = threading.Lock()
        self._failed_attempts: Dict[str, int] = {}
        self._blocked_ips: Set[str] = set()

    def create_user(self, user_id: str, username: str, password: str,
                    roles: Optional[List[str]] = None,
                    bandwidth_limit_bps: int = 0) -> dict:
        with self._lock:
            if user_id in self._users:
                return {"error": f"User '{user_id}' already exists"}
            salt = secrets.token_hex(16)
            pw_hash = hashlib.sha256(f"{password}:{salt}".encode()).hexdigest()
            user = UserAccount(
                user_id=user_id, username=username,
                password_hash=pw_hash, salt=salt,
                roles=roles or ["user"],
                bandwidth_limit_bps=bandwidth_limit_bps
            )
            self._users[user_id] = user
            return {"status": "created", "user": user.to_dict()}

    def authenticate(self, user_id: str, password: str, client_ip: str = "") -> dict:
        with self._lock:
            if client_ip in self._blocked_ips:
                return {"error": "IP blocked"}
            if user_id not in self._users:
                self._record_failure(client_ip)
                return {"error": "Invalid credentials"}
            user = self._users[user_id]
            if not user.is_active:
                return {"error": "Account disabled"}
            expected = hashlib.sha256(f"{password}:{user.salt}".encode()).hexdigest()
            if not hmac.compare_digest(expected, user.password_hash):
                self._record_failure(client_ip)
                return {"error": "Invalid credentials"}
            self._failed_attempts.pop(client_ip, None)
            user.last_login = _time.time()
            token = AuthToken(
                user_id=user_id,
                scopes=user.roles.copy(),
                exit_restrictions=user.allowed_exits,
                ip_bound=client_ip if client_ip else None
            )
            self._tokens[token.token_id] = token
            return {"status": "authenticated", "token": token.to_dict()}

    def validate_token(self, token_id: str, client_ip: str = "") -> dict:
        with self._lock:
            if token_id not in self._tokens:
                return {"valid": False, "error": "Token not found"}
            token = self._tokens[token_id]
            valid = token.is_valid(client_ip)
            return {"valid": valid, "token": token.to_dict() if valid else None}

    def revoke_token(self, token_id: str) -> dict:
        with self._lock:
            if token_id not in self._tokens:
                return {"error": "Token not found"}
            self._tokens[token_id].is_revoked = True
            return {"status": "revoked"}

    def add_access_rule(self, resource: str, action: str = "connect",
                        subject: str = "*", effect: str = "allow",
                        priority: int = 0) -> dict:
        with self._lock:
            rule = AccessRule(resource=resource, action=action,
                            subject=subject, effect=effect, priority=priority)
            self._access_rules.append(rule)
            self._access_rules.sort(key=lambda r: -r.priority)
            return {"status": "created", "rule": rule.to_dict()}

    def check_access(self, token_id: str, resource: str, action: str = "connect") -> dict:
        with self._lock:
            if token_id not in self._tokens:
                return {"allowed": False, "error": "Invalid token"}
            token = self._tokens[token_id]
            user = self._users.get(token.user_id)
            if not user:
                return {"allowed": False, "error": "User not found"}
            roles = user.roles
            for rule in self._access_rules:
                if rule.matches(token.user_id, roles, resource, action):
                    return {"allowed": rule.effect == "allow", "rule": rule.to_dict()}
            return {"allowed": False, "error": "No matching rule"}

    def list_rules(self) -> dict:
        with self._lock:
            return {"rules": [r.to_dict() for r in self._access_rules]}

    def get_auth_stats(self) -> dict:
        with self._lock:
            return {
                "users": len(self._users),
                "active_tokens": sum(1 for t in self._tokens.values() if t.is_valid()),
                "total_tokens": len(self._tokens),
                "access_rules": len(self._access_rules),
                "blocked_ips": len(self._blocked_ips)
            }

    def _record_failure(self, ip: str):
        if ip:
            self._failed_attempts[ip] = self._failed_attempts.get(ip, 0) + 1
            if self._failed_attempts[ip] >= 10:
                self._blocked_ips.add(ip)


_auth = AuthManager()


def create_user_account(user_id: str, username: str, password: str,
                        roles: Optional[List[str]] = None,
                        bandwidth_limit_bps: int = 0) -> dict:
    return _auth.create_user(user_id, username, password, roles, bandwidth_limit_bps)


def login(user_id: str, password: str, client_ip: str = "") -> dict:
    return _auth.authenticate(user_id, password, client_ip)


def verify_token(token_id: str, client_ip: str = "") -> dict:
    return _auth.validate_token(token_id, client_ip)


def logout(token_id: str) -> dict:
    return _auth.revoke_token(token_id)


def add_access_policy(resource: str, action: str = "connect",
                      subject: str = "*", effect: str = "allow",
                      priority: int = 0) -> dict:
    return _auth.add_access_rule(resource, action, subject, effect, priority)


def authorize(token_id: str, resource: str, action: str = "connect") -> dict:
    return _auth.check_access(token_id, resource, action)


def list_access_rules() -> dict:
    return _auth.list_rules()


def get_auth_statistics() -> dict:
    return _auth.get_auth_stats()
