"""
Cryptography Module — key management, encryption, and secure channel setup.
Provides end-to-end encryption helpers for VPN connections.
"""
from dataclasses import dataclass, field
from typing import Optional, Dict, List, Tuple
import hashlib
import hmac
import os as _os
import base64
import time as _time
import secrets


@dataclass
class KeyPair:
    """Public/private key pair."""
    algorithm: str = "x25519"
    public_key: str = ""
    private_key: str = ""
    created_at: float = 0.0
    expires_at: Optional[float] = None
    key_id: str = ""

    def __post_init__(self):
        if not self.key_id:
            self.key_id = secrets.token_hex(8)
        if not self.created_at:
            self.created_at = _time.time()

    def to_dict(self) -> dict:
        return {
            "key_id": self.key_id,
            "algorithm": self.algorithm,
            "public_key": self.public_key[:32] + "..." if len(self.public_key) > 32 else self.public_key,
            "created_at": self.created_at,
            "expires_at": self.expires_at,
            "is_expired": self.expires_at is not None and _time.time() > self.expires_at
        }


@dataclass
class SharedSecret:
    """Derived shared secret from key exchange."""
    secret: str
    algorithm: str
    peer_key_id: str
    our_key_id: str
    created_at: float = 0.0
    cipher: str = "aes-256-gcm"

    def __post_init__(self):
        if not self.created_at:
            self.created_at = _time.time()

    def to_dict(self) -> dict:
        return {
            "algorithm": self.algorithm,
            "cipher": self.cipher,
            "peer_key_id": self.peer_key_id,
            "our_key_id": self.our_key_id,
            "secret_hash": hashlib.sha256(self.secret.encode()).hexdigest()[:16]
        }


@dataclass
class CertificateInfo:
    """X.509-style certificate metadata."""
    subject: str
    issuer: str = ""
    serial: str = ""
    not_before: float = 0.0
    not_after: float = 0.0
    public_key_hash: str = ""
    signature_algorithm: str = "sha256-ecdsa"
    fingerprint: str = ""

    def __post_init__(self):
        if not self.serial:
            self.serial = secrets.token_hex(16)
        if not self.not_before:
            self.not_before = _time.time()
        if not self.not_after:
            self.not_after = self.not_before + 31536000  # 1 year
        if not self.fingerprint:
            self.fingerprint = hashlib.sha256(
                f"{self.subject}{self.serial}".encode()
            ).hexdigest()[:32]

    def to_dict(self) -> dict:
        return {
            "subject": self.subject,
            "issuer": self.issuer,
            "serial": self.serial,
            "valid_from": self.not_before,
            "valid_until": self.not_after,
            "fingerprint": self.fingerprint,
            "signature_algorithm": self.signature_algorithm,
            "is_valid": self.not_before <= _time.time() <= self.not_after
        }


class CryptoManager:
    """Central cryptographic operations manager."""

    def __init__(self):
        self._key_pairs: Dict[str, KeyPair] = {}
        self._shared_secrets: Dict[str, SharedSecret] = {}
        self._certificates: Dict[str, CertificateInfo] = {}
        self._hmac_keys: Dict[str, str] = {}

    def generate_keypair(self, algorithm: str = "x25519",
                         ttl_sec: Optional[int] = None) -> KeyPair:
        """Generate a new keypair."""
        # Mock key generation — real impl would use nacl/cryptography
        raw_private = secrets.token_bytes(32)
        raw_public = hashlib.sha256(raw_private + b"pub").digest()
        
        kp = KeyPair(
            algorithm=algorithm,
            public_key=base64.b64encode(raw_public).decode(),
            private_key=base64.b64encode(raw_private).decode(),
            expires_at=_time.time() + ttl_sec if ttl_sec else None
        )
        self._key_pairs[kp.key_id] = kp
        return kp

    def derive_shared_secret(self, our_key_id: str, peer_public: str) -> SharedSecret:
        """Derive shared secret from our private key and peer public key."""
        if our_key_id not in self._key_pairs:
            raise ValueError(f"Key '{our_key_id}' not found")
        
        kp = self._key_pairs[our_key_id]
        # Mock KDF — real impl would use X25519 + HKDF
        combined = f"{kp.private_key}:{peer_public}".encode()
        secret = base64.b64encode(hashlib.sha256(combined).digest()).decode()
        
        ss = SharedSecret(
            secret=secret,
            algorithm=kp.algorithm,
            peer_key_id="peer-" + secrets.token_hex(4),
            our_key_id=our_key_id
        )
        self._shared_secrets[ss.our_key_id] = ss
        return ss

    def create_certificate(self, subject: str, issuer: str = "",
                          validity_days: int = 365) -> CertificateInfo:
        """Create a self-signed certificate."""
        kp = self.generate_keypair()
        cert = CertificateInfo(
            subject=subject,
            issuer=issuer or subject,
            not_after=_time.time() + validity_days * 86400,
            public_key_hash=hashlib.sha256(kp.public_key.encode()).hexdigest()[:16]
        )
        self._certificates[cert.fingerprint] = cert
        return cert

    def hmac_sign(self, message: str, key_id: str = "default",
                  algorithm: str = "sha256") -> str:
        """HMAC sign a message."""
        if key_id not in self._hmac_keys:
            self._hmac_keys[key_id] = base64.b64encode(
                secrets.token_bytes(32)
            ).decode()
        key = self._hmac_keys[key_id].encode()
        msg = message.encode()
        if algorithm == "sha256":
            sig = hmac.new(key, msg, hashlib.sha256).hexdigest()
        elif algorithm == "sha512":
            sig = hmac.new(key, msg, hashlib.sha512).hexdigest()
        else:
            sig = hmac.new(key, msg, hashlib.sha256).hexdigest()
        return sig

    def hmac_verify(self, message: str, signature: str,
                    key_id: str = "default", algorithm: str = "sha256") -> bool:
        """Verify HMAC signature."""
        expected = self.hmac_sign(message, key_id, algorithm)
        return hmac.compare_digest(expected, signature)

    def encrypt_data(self, plaintext: str, key_id: str) -> dict:
        """Encrypt data with AES-GCM (mock)."""
        # Mock encryption — real impl would use nacl.secretbox
        key = hashlib.sha256(key_id.encode()).digest()
        nonce = secrets.token_bytes(12)
        # Simple XOR-based mock for demonstration
        plain_bytes = plaintext.encode()
        key_stream = hashlib.sha256(key + nonce).digest() * (len(plain_bytes) // 32 + 1)
        cipher_bytes = bytes(a ^ b for a, b in zip(plain_bytes, key_stream[:len(plain_bytes)]))
        
        return {
            "ciphertext": base64.b64encode(cipher_bytes).decode(),
            "nonce": base64.b64encode(nonce).decode(),
            "algorithm": "aes-256-gcm",
            "key_id": key_id
        }

    def decrypt_data(self, ciphertext_b64: str, nonce_b64: str, key_id: str) -> str:
        """Decrypt AES-GCM data (mock)."""
        key = hashlib.sha256(key_id.encode()).digest()
        nonce = base64.b64decode(nonce_b64)
        cipher_bytes = base64.b64decode(ciphertext_b64)
        key_stream = hashlib.sha256(key + nonce).digest() * (len(cipher_bytes) // 32 + 1)
        plain_bytes = bytes(a ^ b for a, b in zip(cipher_bytes, key_stream[:len(cipher_bytes)]))
        return plain_bytes.decode()

    def generate_random_bytes(self, length: int = 32) -> str:
        """Generate cryptographically secure random bytes."""
        return base64.b64encode(secrets.token_bytes(length)).decode()

    def get_stats(self) -> dict:
        return {
            "key_pairs": len(self._key_pairs),
            "shared_secrets": len(self._shared_secrets),
            "certificates": len(self._certificates),
            "hmac_keys": len(self._hmac_keys)
        }


_crypto = CryptoManager()


# Public API
def generate_keypair(algorithm: str = "x25519", ttl_hours: Optional[int] = None) -> dict:
    ttl_sec = ttl_hours * 3600 if ttl_hours else None
    kp = _crypto.generate_keypair(algorithm, ttl_sec)
    return {"status": "ok", "keypair": kp.to_dict()}


def derive_shared_secret(our_key_id: str, peer_public_key: str) -> dict:
    try:
        ss = _crypto.derive_shared_secret(our_key_id, peer_public_key)
        return {"status": "ok", "shared_secret": ss.to_dict()}
    except ValueError as e:
        return {"error": str(e)}


def create_certificate(subject: str, issuer: str = "",
                       validity_days: int = 365) -> dict:
    cert = _crypto.create_certificate(subject, issuer, validity_days)
    return {"status": "ok", "certificate": cert.to_dict()}


def sign_message(message: str, key_id: str = "default",
                 algorithm: str = "sha256") -> dict:
    signature = _crypto.hmac_sign(message, key_id, algorithm)
    return {"signature": signature, "algorithm": f"hmac-{algorithm}",
            "key_id": key_id}


def verify_signature(message: str, signature: str,
                     key_id: str = "default", algorithm: str = "sha256") -> dict:
    valid = _crypto.hmac_verify(message, signature, key_id, algorithm)
    return {"valid": valid, "message": message}


def encrypt(plaintext: str, key_id: str) -> dict:
    result = _crypto.encrypt_data(plaintext, key_id)
    result["status"] = "encrypted"
    return result


def decrypt(ciphertext: str, nonce: str, key_id: str) -> dict:
    try:
        plaintext = _crypto.decrypt_data(ciphertext, nonce, key_id)
        return {"status": "decrypted", "plaintext": plaintext}
    except Exception as e:
        return {"error": str(e)}


def generate_nonce(length: int = 16) -> dict:
    return {"nonce": secrets.token_hex(length)}


def generate_random(length: int = 32) -> dict:
    return {"random_bytes": _crypto.generate_random_bytes(length)}


def get_crypto_stats() -> dict:
    return _crypto.get_stats()


def hash_data(data: str, algorithm: str = "sha256") -> dict:
    if algorithm == "sha256":
        h = hashlib.sha256(data.encode()).hexdigest()
    elif algorithm == "sha512":
        h = hashlib.sha512(data.encode()).hexdigest()
    elif algorithm == "md5":
        h = hashlib.md5(data.encode()).hexdigest()
    else:
        h = hashlib.sha256(data.encode()).hexdigest()
    return {"hash": h, "algorithm": algorithm}


def pbkdf2_derive(password: str, salt: Optional[str] = None,
                  iterations: int = 100000, key_length: int = 32,
                  algorithm: str = "sha256") -> dict:
    if not salt:
        salt = secrets.token_hex(16)
    derived = hashlib.pbkdf2_hmac(algorithm, password.encode(),
                                   salt.encode(), iterations,
                                   dklen=key_length)
    return {
        "derived_key": derived.hex(),
        "salt": salt,
        "iterations": iterations,
        "algorithm": f"pbkdf2-{algorithm}"
    }
