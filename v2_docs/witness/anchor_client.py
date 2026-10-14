"""
Chain of Custody - Cloudflare Anchor Client
Used by the Witness to anchor chain heads externally, and by the Auditor tab
to verify that local chain heads match the external Cloudflare public notary.
"""

import requests
import logging
from typing import Optional, Dict, Any

logger = logging.getLogger("anchor_client")

class CloudflareAnchorClient:
    def __init__(self, anchor_url: str = "http://127.0.0.1:8787", witness_key: Optional[str] = "witness_genesis_public_key_or_secret"):
        self.anchor_url = anchor_url.rstrip("/")
        self.witness_key = witness_key

    def anchor_chain_head(self, seq: int, chain_head: str, timestamp: str, signature: Optional[str] = None) -> Dict[str, Any]:
        """
        Submits the latest chain head to the Cloudflare Worker anchor.
        Returns the anchor receipt.
        """
        url = f"{self.anchor_url}/anchor"
        headers = {
            "Content-Type": "application/json",
            "X-Witness-Key": self.witness_key or ""
        }
        payload = {
            "seq": seq,
            "chain_head": chain_head,
            "timestamp": timestamp,
            "signature": signature
        }

        try:
            resp = requests.post(url, json=payload, headers=headers, timeout=5)
            resp.raise_for_status()
            return resp.json()
        except requests.exceptions.RequestException as e:
            logger.error(f"Failed to post anchor to Cloudflare at seq {seq}: {e}")
            raise

    def get_latest_anchor(self) -> Dict[str, Any]:
        """
        Retrieves the latest anchor committed to Cloudflare.
        """
        url = f"{self.anchor_url}/anchor/latest"
        resp = requests.get(url, timeout=5)
        resp.raise_for_status()
        return resp.json()

    def get_anchor_at_seq(self, seq: int) -> Dict[str, Any]:
        """
        Retrieves the anchor committed to Cloudflare for a specific sequence number.
        """
        url = f"{self.anchor_url}/anchor/{seq}"
        resp = requests.get(url, timeout=5)
        resp.raise_for_status()
        return resp.json()

    def verify_against_anchor(self, seq: int, local_chain_head: str) -> Dict[str, Any]:
        """
        Calls Cloudflare public notary to verify if a local chain head matches the public anchor.
        Detects Attack A10 (Witness rewriting history).
        """
        url = f"{self.anchor_url}/verify"
        params = {"seq": seq, "hash": local_chain_head}
        try:
            resp = requests.get(url, params=params, timeout=5)
            resp.raise_for_status()
            return resp.json()
        except requests.exceptions.HTTPError as e:
            if resp.status_code == 404:
                return {
                    "verified": False,
                    "seq": seq,
                    "error": f"Seq {seq} not anchored in Cloudflare."
                }
            raise
