"""
Version & Constants - version info and system constants.
"""
VERSION = "2.0.0"
BUILD = "2026-08-05"
PROTOCOL_VERSION = 2
DEFAULT_PORT = 1080
MAX_PACKET_SIZE = 65536
SOCKS5_VERSION = 5
AUTH_METHODS = ["none", "password", "token"]
SUPPORTED_CIPHERS = ["aes-256-gcm", "chacha20-poly1305"]
SUPPORTED_KEX = ["x25519", "p256"]
COMPRESSION_ALGOS = ["none", "gzip", "lz4"]
CONNECTION_TIMEOUT = 30
KEEPALIVE_INTERVAL = 60
MAX_RETRIES = 3
RETRY_BACKOFF = 2.0
EXIT_HEARTBEAT_INTERVAL = 30
MAX_EXIT_AGE = 3600
DNS_CACHE_TTL = 300
BUFFER_SIZE = 8192
RECONNECT_DELAY = 5

def get_version() -> dict:
    return {"version": VERSION, "build": BUILD, "protocol": PROTOCOL_VERSION}

def get_constants() -> dict:
    return {
        "default_port": DEFAULT_PORT,
        "max_packet_size": MAX_PACKET_SIZE,
        "connection_timeout": CONNECTION_TIMEOUT,
        "keepalive_interval": KEEPALIVE_INTERVAL,
        "supported_ciphers": SUPPORTED_CIPHERS,
        "supported_kex": SUPPORTED_KEX
    }
