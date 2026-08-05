"""
Configuration Management - dynamic configuration, hot-reload, and validation.
Provides configuration file management with validation and hot reload.
"""
from dataclasses import dataclass, field
from typing import Optional, Dict, List, Any, Union
import json
import os as _os
import time as _time
import threading
import copy


@dataclass
class ConfigValue:
    key: str
    value: Any
    default: Any = None
    description: str = ""
    required: bool = False
    validator: Optional[str] = None
    updated_at: float = 0.0
    source: str = "default"

    def __post_init__(self):
        if not self.updated_at:
            self.updated_at = _time.time()

    def to_dict(self) -> dict:
        return {
            "key": self.key,
            "value": self.value,
            "default": self.default,
            "description": self.description,
            "required": self.required,
            "source": self.source,
            "updated_at": self.updated_at
        }


@dataclass
class ConfigSection:
    name: str
    values: Dict[str, ConfigValue] = field(default_factory=dict)
    description: str = ""

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "description": self.description,
            "values": {k: v.to_dict() for k, v in self.values.items()}
        }


class ConfigManager:
    def __init__(self):
        self._sections: Dict[str, ConfigSection] = {}
        self._lock = threading.Lock()
        self._reload_hooks: List[callable] = []
        self._config_file: Optional[str] = None
        self._last_loaded: float = 0.0
        self._init_defaults()

    def _init_defaults(self):
        self.register_section("network", "Network configuration")
        self.register_section("security", "Security and encryption settings")
        self.register_section("performance", "Performance tuning")
        self.register_section("logging", "Logging configuration")

        self.set("network", "listen_port", 1080, description="Proxy listen port", validator="int")
        self.set("network", "listen_address", "0.0.0.0", description="Bind address", validator="str")
        self.set("network", "max_connections", 1000, description="Max concurrent connections", validator="int")
        self.set("network", "timeout_sec", 30, description="Connection timeout seconds", validator="int")
        self.set("network", "tcp_nodelay", True, description="TCP_NODELAY socket option", validator="bool")

        self.set("security", "encryption_enabled", True, description="Enable encryption", validator="bool")
        self.set("security", "min_tls_version", "1.2", description="Minimum TLS version", validator="str")
        self.set("security", "cert_file", "", description="TLS certificate path", validator="str")
        self.set("security", "key_file", "", description="TLS key path", validator="str")
        self.set("security", "require_client_cert", False, description="Require client certificates", validator="bool")

        self.set("performance", "buffer_size", 65536, description="IO buffer size", validator="int")
        self.set("performance", "worker_threads", 4, description="Worker thread count", validator="int")
        self.set("performance", "max_packet_size", 65536, description="Max packet size", validator="int")
        self.set("performance", "compression_level", 6, description="Compression level (0-9)", validator="int")
        self.set("performance", "enable_compression", False, description="Enable data compression", validator="bool")

        self.set("logging", "level", "info", description="Log level (debug/info/warn/error)", validator="str")
        self.set("logging", "format", "json", description="Log format (json/text)", validator="str")
        self.set("logging", "output", "stdout", description="Log output (stdout/stderr/file)", validator="str")
        self.set("logging", "file_path", "", description="Log file path", validator="str")
        self.set("logging", "max_file_size_mb", 100, description="Max log file size", validator="int")

    def register_section(self, name: str, description: str = ""):
        with self._lock:
            if name not in self._sections:
                self._sections[name] = ConfigSection(name=name, description=description)

    def set(self, section: str, key: str, value: Any,
            description: str = "", required: bool = False,
            validator: Optional[str] = None, source: str = "runtime") -> dict:
        with self._lock:
            if section not in self._sections:
                self.register_section(section)
            cv = ConfigValue(key=key, value=value, description=description,
                           required=required, validator=validator, source=source)
            self._sections[section].values[key] = cv
            return {"status": "set", "section": section, "key": key, "value": value}

    def get(self, section: str, key: str, default: Any = None) -> Any:
        with self._lock:
            if section not in self._sections:
                return default
            section_obj = self._sections[section]
            if key not in section_obj.values:
                return default
            return section_obj.values[key].value

    def get_section(self, section: str) -> dict:
        with self._lock:
            if section not in self._sections:
                return {"error": f"Section '{section}' not found"}
            return self._sections[section].to_dict()

    def get_all(self) -> dict:
        with self._lock:
            return {
                "sections": {name: sec.to_dict() for name, sec in self._sections.items()},
                "config_file": self._config_file,
                "last_loaded": self._last_loaded
            }

    def validate(self) -> dict:
        errors = []
        with self._lock:
            for sec_name, section in self._sections.items():
                for key, cv in section.values.items():
                    if cv.required and cv.value is None:
                        errors.append(f"[{sec_name}].{key}: required but not set")
                    if cv.validator and cv.value is not None:
                        validators = {
                            "int": lambda v: isinstance(v, int),
                            "float": lambda v: isinstance(v, (int, float)),
                            "str": lambda v: isinstance(v, str),
                            "bool": lambda v: isinstance(v, bool),
                            "list": lambda v: isinstance(v, (list, tuple)),
                        }
                        vfn = validators.get(cv.validator)
                        if vfn and not vfn(cv.value):
                            errors.append(f"[{sec_name}].{key}: expected {cv.validator}")
        return {"valid": len(errors) == 0, "errors": errors}

    def load_file(self, filepath: str) -> dict:
        try:
            with open(filepath, 'r') as f:
                data = json.load(f)
            with self._lock:
                for section_name, values in data.items():
                    if isinstance(values, dict):
                        for key, value in values.items():
                            self.set(section_name, key, value, source="file")
                self._config_file = filepath
                self._last_loaded = _time.time()
                for hook in self._reload_hooks:
                    try:
                        hook()
                    except:
                        pass
            return {"status": "loaded", "file": filepath}
        except Exception as e:
            return {"error": str(e)}

    def save_file(self, filepath: str) -> dict:
        try:
            data = {}
            for sec_name, section in self._sections.items():
                data[sec_name] = {k: v.value for k, v in section.values.items()}
            with open(filepath, 'w') as f:
                json.dump(data, f, indent=2)
            return {"status": "saved", "file": filepath}
        except Exception as e:
            return {"error": str(e)}

    def register_reload_hook(self, hook: callable):
        self._reload_hooks.append(hook)

    def hot_reload(self) -> dict:
        if not self._config_file:
            return {"error": "No config file loaded"}
        return self.load_file(self._config_file)

    def reset_section(self, section: str) -> dict:
        with self._lock:
            if section in self._sections:
                del self._sections[section]
            return {"status": "reset", "section": section}


_config = ConfigManager()


def set_config(section: str, key: str, value: Any) -> dict:
    return _config.set(section, key, value)


def get_config(section: str, key: str, default: Any = None) -> Any:
    return _config.get(section, key, default)


def get_config_section(section: str) -> dict:
    return _config.get_section(section)


def get_all_config() -> dict:
    return _config.get_all()


def validate_config() -> dict:
    return _config.validate()


def load_config_file(filepath: str) -> dict:
    return _config.load_file(filepath)


def save_config_file(filepath: str) -> dict:
    return _config.save_file(filepath)


def reload_config() -> dict:
    return _config.hot_reload()


def reset_config_section(section: str) -> dict:
    return _config.reset_section(section)
