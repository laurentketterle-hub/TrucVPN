"""
Event System Module - pub/sub event bus with filtering and batching.
Provides asynchronous event publishing and subscription management.
"""
from dataclasses import dataclass, field
from typing import Optional, Dict, List, Any, Callable, Set
import time as _time
import threading
import queue
import uuid
import json


@dataclass
class Event:
    """An event in the system."""
    event_id: str = ""
    event_type: str = ""
    source: str = ""
    timestamp: float = 0.0
    payload: Dict[str, Any] = field(default_factory=dict)
    correlation_id: str = ""
    priority: int = 0

    def __post_init__(self):
        if not self.event_id:
            self.event_id = str(uuid.uuid4())[:12]
        if not self.timestamp:
            self.timestamp = _time.time()

    def to_dict(self) -> dict:
        return {
            "event_id": self.event_id,
            "event_type": self.event_type,
            "source": self.source,
            "timestamp": self.timestamp,
            "payload": self.payload,
            "correlation_id": self.correlation_id,
            "priority": self.priority
        }


@dataclass
class Subscription:
    """A subscription to events."""
    sub_id: str = ""
    event_type: str = "*"
    source: str = "*"
    handler: Optional[Callable] = None
    filter_fn: Optional[Callable] = None
    created_at: float = 0.0
    is_active: bool = True
    max_queue_size: int = 1000
    drop_on_overflow: bool = True
    _queue: queue.Queue = field(default_factory=queue.Queue)

    def __post_init__(self):
        if not self.sub_id:
            self.sub_id = "sub-" + str(uuid.uuid4())[:8]
        if not self.created_at:
            self.created_at = _time.time()

    def matches(self, event: Event) -> bool:
        if not self.is_active:
            return False
        if self.event_type != "*" and self.event_type != event.event_type:
            return False
        if self.source != "*" and self.source != event.source:
            return False
        if self.filter_fn and not self.filter_fn(event):
            return False
        return True

    def to_dict(self) -> dict:
        return {
            "sub_id": self.sub_id,
            "event_type": self.event_type,
            "source": self.source,
            "created_at": self.created_at,
            "is_active": self.is_active,
            "queue_size": self._queue.qsize()
        }


class EventBus:
    """Central event bus with pub/sub."""

    def __init__(self):
        self._subscriptions: Dict[str, Subscription] = {}
        self._lock = threading.Lock()
        self._event_count: Dict[str, int] = {}
        self._started_at = _time.time()
        self._running = True

    def subscribe(self, event_type: str = "*", source: str = "*",
                  handler: Optional[Callable] = None,
                  filter_fn: Optional[Callable] = None,
                  max_queue_size: int = 1000) -> dict:
        sub = Subscription(
            event_type=event_type, source=source,
            handler=handler, filter_fn=filter_fn,
            max_queue_size=max_queue_size
        )
        with self._lock:
            self._subscriptions[sub.sub_id] = sub
        return {"status": "subscribed", "subscription": sub.to_dict()}

    def unsubscribe(self, sub_id: str) -> dict:
        with self._lock:
            if sub_id in self._subscriptions:
                del self._subscriptions[sub_id]
                return {"status": "unsubscribed"}
            return {"error": f"Subscription '{sub_id}' not found"}

    def publish(self, event_type: str, source: str = "",
                payload: Optional[Dict[str, Any]] = None,
                correlation_id: str = "", priority: int = 0) -> dict:
        event = Event(
            event_type=event_type, source=source,
            payload=payload or {}, correlation_id=correlation_id,
            priority=priority
        )
        with self._lock:
            self._event_count[event_type] = self._event_count.get(event_type, 0) + 1
            delivered = 0
            for sub in self._subscriptions.values():
                if sub.matches(event):
                    if sub._queue.qsize() < sub.max_queue_size:
                        sub._queue.put(event)
                        delivered += 1
                    elif not sub.drop_on_overflow:
                        sub._queue.put(event)
                        delivered += 1
        return {
            "status": "published",
            "event_id": event.event_id,
            "delivered_to": delivered,
            "total_subscriptions": len(self._subscriptions)
        }

    def publish_batch(self, events_data: List[Dict[str, Any]]) -> dict:
        results = []
        for ed in events_data:
            r = self.publish(
                event_type=ed.get("event_type", ""),
                source=ed.get("source", ""),
                payload=ed.get("payload"),
                correlation_id=ed.get("correlation_id", ""),
                priority=ed.get("priority", 0)
            )
            results.append(r["event_id"])
        return {"status": "batch_published", "event_ids": results, "count": len(results)}

    def consume(self, sub_id: str, timeout: float = 1.0) -> dict:
        """Consume one event from a subscription queue."""
        with self._lock:
            if sub_id not in self._subscriptions:
                return {"error": f"Subscription '{sub_id}' not found"}
            sub = self._subscriptions[sub_id]
        try:
            event = sub._queue.get(timeout=timeout)
            if sub.handler:
                try:
                    sub.handler(event)
                except:
                    pass
            return {"event": event.to_dict()}
        except queue.Empty:
            return {"event": None, "message": "No events available"}

    def consume_all(self, sub_id: str, max_events: int = 100) -> dict:
        """Consume all available events from a subscription queue."""
        with self._lock:
            if sub_id not in self._subscriptions:
                return {"error": f"Subscription '{sub_id}' not found"}
            sub = self._subscriptions[sub_id]
        events = []
        try:
            for _ in range(max_events):
                event = sub._queue.get_nowait()
                events.append(event.to_dict())
                if sub.handler:
                    try: sub.handler(event)
                    except: pass
        except queue.Empty:
            pass
        return {"events": events, "count": len(events)}

    def get_stats(self) -> dict:
        with self._lock:
            return {
                "total_events": sum(self._event_count.values()),
                "event_counts": self._event_count.copy(),
                "active_subscriptions": len(self._subscriptions),
                "subscriptions": [s.to_dict() for s in self._subscriptions.values()],
                "uptime_sec": round(_time.time() - self._started_at, 1)
            }

    def get_events_by_type(self, event_type: str) -> dict:
        with self._lock:
            return {
                "event_type": event_type,
                "count": self._event_count.get(event_type, 0)
            }

    def shutdown(self):
        self._running = False


_bus = EventBus()


def subscribe_to_events(event_type: str = "*", source: str = "*") -> dict:
    return _bus.subscribe(event_type, source)


def unsubscribe_from_events(sub_id: str) -> dict:
    return _bus.unsubscribe(sub_id)


def publish_event(event_type: str, source: str = "",
                  payload: Optional[Dict[str, Any]] = None,
                  correlation_id: str = "", priority: int = 0) -> dict:
    return _bus.publish(event_type, source, payload, correlation_id, priority)


def publish_event_batch(events: List[Dict[str, Any]]) -> dict:
    return _bus.publish_batch(events)


def consume_event(sub_id: str, timeout: float = 1.0) -> dict:
    return _bus.consume(sub_id, timeout)


def consume_all_events(sub_id: str, max_events: int = 100) -> dict:
    return _bus.consume_all(sub_id, max_events)


def get_event_stats() -> dict:
    return _bus.get_stats()


def get_event_count_by_type(event_type: str) -> dict:
    return _bus.get_events_by_type(event_type)
