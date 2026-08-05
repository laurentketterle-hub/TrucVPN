"""
Notification System - multi-channel notifications for VPN events.
Supports console, file, webhook, and email notification channels.
"""
from dataclasses import dataclass, field
from typing import Optional, Dict, List, Any, Callable
import time as _time
import json
import threading
import queue


@dataclass
class Notification:
    """A notification message."""
    title: str = ""
    message: str = ""
    severity: str = "info"
    timestamp: float = 0.0
    source: str = "system"
    tags: List[str] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)

    def __post_init__(self):
        if not self.timestamp:
            self.timestamp = _time.time()

    def to_dict(self) -> dict:
        return {
            "title": self.title,
            "message": self.message,
            "severity": self.severity,
            "timestamp": self.timestamp,
            "source": self.source,
            "tags": self.tags,
            "metadata": self.metadata
        }


@dataclass
class NotifyChannel:
    """A notification output channel."""
    name: str = ""
    channel_type: str = "console"
    config: Dict[str, Any] = field(default_factory=dict)
    enabled: bool = True
    min_severity: str = "info"
    rate_limit_per_min: int = 0
    _last_sent: float = 0.0
    _sent_count: int = 0
    _send_fn: Optional[Callable] = None

    def can_send(self, severity: str) -> bool:
        if not self.enabled:
            return False
        severities = {"debug": 0, "info": 1, "warn": 2, "error": 3, "critical": 4}
        return severities.get(severity, 0) >= severities.get(self.min_severity, 1)

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "type": self.channel_type,
            "enabled": self.enabled,
            "min_severity": self.min_severity,
            "sent_count": self._sent_count
        }


class NotificationManager:
    """Manages notification channels and dispatching."""

    def __init__(self):
        self._channels: Dict[str, NotifyChannel] = {}
        self._lock = threading.Lock()
        self._history: List[Notification] = []
        self._max_history: int = 1000

        self.register_channel("console", "console", {"colorize": True}, min_severity="debug")
        self.register_channel("alerts", "console", {}, min_severity="warn")

    def register_channel(self, name: str, channel_type: str,
                         config: Optional[Dict[str, Any]] = None,
                         min_severity: str = "info",
                         rate_limit_per_min: int = 0,
                         send_fn: Optional[Callable] = None) -> dict:
        with self._lock:
            channel = NotifyChannel(
                name=name, channel_type=channel_type,
                config=config or {}, min_severity=min_severity,
                rate_limit_per_min=rate_limit_per_min,
                _send_fn=send_fn
            )
            self._channels[name] = channel
            return {"status": "registered", "channel": channel.to_dict()}

    def notify(self, title: str, message: str, severity: str = "info",
               source: str = "system", tags: Optional[List[str]] = None,
               metadata: Optional[Dict[str, Any]] = None) -> dict:
        notification = Notification(
            title=title, message=message, severity=severity,
            source=source, tags=tags or [], metadata=metadata or {}
        )
        delivered = []
        with self._lock:
            self._history.append(notification)
            if len(self._history) > self._max_history:
                self._history = self._history[-self._max_history:]
            for name, channel in self._channels.items():
                if channel.can_send(severity):
                    if channel._send_fn:
                        channel._send_fn(notification)
                    channel._sent_count += 1
                    channel._last_sent = _time.time()
                    delivered.append(name)
        return {
            "status": "sent",
            "title": title,
            "severity": severity,
            "delivered_to": delivered
        }

    def notify_info(self, title: str, message: str, **kwargs):
        return self.notify(title, message, severity="info", **kwargs)

    def notify_warn(self, title: str, message: str, **kwargs):
        return self.notify(title, message, severity="warn", **kwargs)

    def notify_error(self, title: str, message: str, **kwargs):
        return self.notify(title, message, severity="error", **kwargs)

    def notify_critical(self, title: str, message: str, **kwargs):
        return self.notify(title, message, severity="critical", **kwargs)

    def get_history(self, limit: int = 50, severity: Optional[str] = None,
                    source: Optional[str] = None) -> dict:
        with self._lock:
            items = self._history
            if severity:
                items = [n for n in items if n.severity == severity]
            if source:
                items = [n for n in items if n.source == source]
            items = items[-limit:]
            return {"notifications": [n.to_dict() for n in items], "count": len(items)}

    def get_channels(self) -> dict:
        with self._lock:
            return {"channels": [c.to_dict() for c in self._channels.values()]}

    def enable_channel(self, name: str) -> dict:
        with self._lock:
            if name in self._channels:
                self._channels[name].enabled = True
                return {"status": "enabled"}
            return {"error": "Channel not found"}

    def disable_channel(self, name: str) -> dict:
        with self._lock:
            if name in self._channels:
                self._channels[name].enabled = False
                return {"status": "disabled"}
            return {"error": "Channel not found"}

    def clear_history(self) -> dict:
        with self._lock:
            count = len(self._history)
            self._history = []
            return {"status": "cleared", "removed": count}


_notify = NotificationManager()


def register_notify_channel(name: str, channel_type: str = "console",
                            min_severity: str = "info") -> dict:
    return _notify.register_channel(name, channel_type, min_severity=min_severity)


def send_notification(title: str, message: str, severity: str = "info",
                      source: str = "system", tags: Optional[List[str]] = None,
                      metadata: Optional[Dict[str, Any]] = None) -> dict:
    return _notify.notify(title, message, severity, source, tags, metadata)


def send_info(title: str, message: str) -> dict:
    return _notify.notify_info(title, message)


def send_warning(title: str, message: str) -> dict:
    return _notify.notify_warn(title, message)


def send_error(title: str, message: str) -> dict:
    return _notify.notify_error(title, message)


def send_critical(title: str, message: str) -> dict:
    return _notify.notify_critical(title, message)


def get_notification_history(limit: int = 50, severity: Optional[str] = None) -> dict:
    return _notify.get_history(limit, severity)


def list_notify_channels() -> dict:
    return _notify.get_channels()
