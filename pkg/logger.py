"""
Structured Logging Module - leveled logging with rotation and formatting.
Provides JSON and text logging with file rotation and level filtering.
"""
from dataclasses import dataclass, field
from typing import Optional, Dict, List, Any, TextIO
import time as _time
import json
import threading
import os as _os
import sys


LOG_LEVELS = {"DEBUG": 10, "INFO": 20, "WARN": 30, "ERROR": 40, "FATAL": 50}
LEVEL_NAMES = {v: k for k, v in LOG_LEVELS.items()}


@dataclass
class LogEntry:
    """A single log entry."""
    level: str = "INFO"
    message: str = ""
    timestamp: float = 0.0
    logger_name: str = "root"
    fields: Dict[str, Any] = field(default_factory=dict)
    file: str = ""
    line: int = 0
    function: str = ""

    def __post_init__(self):
        if not self.timestamp:
            self.timestamp = _time.time()

    def to_dict(self) -> dict:
        return {
            "timestamp": _time.strftime("%Y-%m-%dT%H:%M:%S.000Z", _time.gmtime(self.timestamp)),
            "level": self.level,
            "logger": self.logger_name,
            "message": self.message,
            "fields": self.fields,
            "caller": f"{self.file}:{self.line}" if self.file else ""
        }

    def to_text(self) -> str:
        ts = _time.strftime("%Y-%m-%d %H:%M:%S", _time.localtime(self.timestamp))
        caller = f" [{self.file}:{self.line}]" if self.file else ""
        fields = " " + json.dumps(self.fields) if self.fields else ""
        return f"{ts} {self.level:5s} [{self.logger_name}]{caller} {self.message}{fields}"


@dataclass
class LoggerConfig:
    """Logger configuration."""
    level: str = "INFO"
    format: str = "json"
    output: str = "stdout"
    file_path: str = ""
    max_file_size_mb: int = 100
    max_backups: int = 3
    enable_colors: bool = False
    include_caller: bool = True

    def to_dict(self) -> dict:
        return {
            "level": self.level,
            "format": self.format,
            "output": self.output,
            "file_path": self.file_path,
            "max_file_size_mb": self.max_file_size_mb,
            "max_backups": self.max_backups
        }


class Logger:
    """Structured logger with leveled output."""

    def __init__(self, name: str = "root", config: Optional[LoggerConfig] = None):
        self.name = name
        self.config = config or LoggerConfig()
        self._lock = threading.Lock()
        self._file: Optional[TextIO] = None
        self._file_size: int = 0
        self._msg_count: Dict[str, int] = {}
        self._last_flush: float = _time.time()
        self._setup_output()

    def _setup_output(self):
        if self.config.output == "file" and self.config.file_path:
            try:
                _os.makedirs(_os.path.dirname(self.config.file_path), exist_ok=True)
                self._file = open(self.config.file_path, 'a', encoding='utf-8')
                self._file_size = _os.path.getsize(self.config.file_path)
            except:
                pass

    def _should_log(self, level: str) -> bool:
        return LOG_LEVELS.get(level, 0) >= LOG_LEVELS.get(self.config.level, 20)

    def _format(self, entry: LogEntry) -> str:
        if self.config.format == "json":
            return json.dumps(entry.to_dict())
        return entry.to_text()

    def _write(self, line: str):
        if self._file:
            self._file.write(line + "
")
            self._file_size += len(line) + 1
            if self._file_size > self.config.max_file_size_mb * 1_000_000:
                self._rotate()
        if self.config.output == "stdout" or not self._file:
            sys.stderr.write(line + "
")
        self._last_flush = _time.time()
        if _time.time() - self._last_flush > 5 and self._file:
            self._file.flush()

    def _rotate(self):
        if self._file:
            self._file.close()
        base = self.config.file_path
        for i in range(self.config.max_backups - 1, 0, -1):
            src = f"{base}.{i}"
            dst = f"{base}.{i + 1}"
            if _os.path.exists(src):
                try: _os.rename(src, dst)
                except: pass
        if _os.path.exists(base):
            try: _os.rename(base, f"{base}.1")
            except: pass
        self._file = open(base, 'w', encoding='utf-8')
        self._file_size = 0

    def _log(self, level: str, message: str, **fields):
        if not self._should_log(level):
            return
        entry = LogEntry(level=level, message=message, logger_name=self.name, fields=fields)
        with self._lock:
            self._msg_count[level] = self._msg_count.get(level, 0) + 1
            self._write(self._format(entry))

    def debug(self, message: str, **fields):
        self._log("DEBUG", message, **fields)

    def info(self, message: str, **fields):
        self._log("INFO", message, **fields)

    def warn(self, message: str, **fields):
        self._log("WARN", message, **fields)

    def error(self, message: str, **fields):
        self._log("ERROR", message, **fields)

    def fatal(self, message: str, **fields):
        self._log("FATAL", message, **fields)

    def get_stats(self) -> dict:
        with self._lock:
            return {
                "logger": self.name,
                "level": self.config.level,
                "message_counts": self._msg_count.copy(),
                "total_messages": sum(self._msg_count.values()),
                "output": self.config.output,
                "file_size": self._file_size
            }

    def set_level(self, level: str):
        if level in LOG_LEVELS:
            self.config.level = level

    def close(self):
        if self._file:
            self._file.close()
            self._file = None


_loggers: Dict[str, Logger] = {}
_loggers_lock = threading.Lock()


def get_logger(name: str = "root", config: Optional[LoggerConfig] = None) -> Logger:
    with _loggers_lock:
        if name not in _loggers:
            _loggers[name] = Logger(name, config)
        return _loggers[name]


_default_logger = get_logger("vpn")


def log_debug(message: str, **fields):
    _default_logger.debug(message, **fields)


def log_info(message: str, **fields):
    _default_logger.info(message, **fields)


def log_warn(message: str, **fields):
    _default_logger.warn(message, **fields)


def log_error(message: str, **fields):
    _default_logger.error(message, **fields)


def log_fatal(message: str, **fields):
    _default_logger.fatal(message, **fields)


def configure_logger(level: str = "INFO", format: str = "json",
                     output: str = "stdout", file_path: str = "") -> dict:
    _default_logger.config.level = level
    _default_logger.config.format = format
    _default_logger.config.output = output
    _default_logger.config.file_path = file_path
    return {"status": "configured", "config": _default_logger.config.to_dict()}


def get_logger_stats() -> dict:
    return _default_logger.get_stats()


def set_log_level(level: str) -> dict:
    if level not in LOG_LEVELS:
        return {"error": f"Invalid level: {level}"}
    _default_logger.set_level(level)
    return {"status": "ok", "level": level}
