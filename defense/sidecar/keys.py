"""Ed25519 key pair management and signing over canonical JSON payloads."""
import os
from pathlib import Path
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)

from sidecar.canon import canonical_json_bytes


def public_key_hex(private_key: Ed25519PrivateKey) -> str:
    """Derive the raw public key of a private key as lowercase hex."""
    pub_bytes = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return pub_bytes.hex()


def generate_keypair() -> tuple[Ed25519PrivateKey, str]:
    """Generate a new Ed25519 private key and return (private_key, public_key_hex)."""
    private_key = Ed25519PrivateKey.generate()
    return private_key, public_key_hex(private_key)


def save_keypair(
    private_key: Ed25519PrivateKey,
    public_hex: str,
    private_path: Path,
    public_path: Path,
) -> None:
    """Save private key as PEM (new file only, owner-only mode) and public key as hex."""
    private_path.parent.mkdir(parents=True, exist_ok=True)
    public_path.parent.mkdir(parents=True, exist_ok=True)

    pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    # O_EXCL: never overwrite an existing private key.
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
    with os.fdopen(os.open(private_path, flags, 0o600), "wb") as f:
        f.write(pem)
    public_path.write_text(public_hex, encoding="utf-8")


def load_or_generate_keypair(
    private_path: Path,
    public_path: Path,
) -> tuple[Ed25519PrivateKey, str]:
    """Load the node key pair, or create one only if neither key file exists."""
    if private_path.exists():
        pem = private_path.read_bytes()
        private_key = serialization.load_pem_private_key(pem, password=None)
        if not isinstance(private_key, Ed25519PrivateKey):
            raise TypeError("Loaded private key is not an Ed25519 key")
        public_hex = public_key_hex(private_key)
        if not public_path.exists():
            public_path.write_text(public_hex, encoding="utf-8")
        elif public_path.read_text(encoding="utf-8").strip() != public_hex:
            raise ValueError(f"Public key file {public_path} does not match the private key")
        return private_key, public_hex

    if public_path.exists():
        raise FileNotFoundError(
            f"Private key {private_path} is missing but {public_path} exists; "
            "refusing to create a new node identity"
        )
    private_key, public_hex = generate_keypair()
    save_keypair(private_key, public_hex, private_path, public_path)
    return private_key, public_hex


def sign_payload(
    private_key: Ed25519PrivateKey,
    payload_without_signature: dict[str, Any],
) -> str:
    """Sign canonical JSON bytes of payload and return lowercase hex signature."""
    data = canonical_json_bytes(payload_without_signature)
    sig_bytes = private_key.sign(data)
    return sig_bytes.hex()


def verify_payload(
    public_key_hex: str,
    signature_hex: str,
    payload_without_signature: dict[str, Any],
) -> bool:
    """Verify an Ed25519 hex signature over canonical JSON bytes using a public key hex."""
    try:
        pub_bytes = bytes.fromhex(public_key_hex)
        sig_bytes = bytes.fromhex(signature_hex)
        public_key = Ed25519PublicKey.from_public_bytes(pub_bytes)
        data = canonical_json_bytes(payload_without_signature)
        public_key.verify(sig_bytes, data)
        return True
    except (InvalidSignature, ValueError, TypeError):
        return False
