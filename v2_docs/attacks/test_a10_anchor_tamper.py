"""
Test & Red Team Demo: Attack A10 Mitigation via Cloudflare Public Anchor

Demonstrates:
1. Valid anchoring of chain heads to Cloudflare Notary.
2. Monotonicity enforcement (cannot rewrite or overwrite past sequence numbers).
3. Auditor verification pass when chain is intact.
4. Attack A10 caught: An attacker compromises the witness database, alters an old block hash,
   and attempts to present the rewritten chain to the auditor. The Cloudflare Public Anchor
   exposes the split-view contradiction!
"""

import sys
import os
from fastapi.testclient import TestClient

# Ensure root directory is in sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from cloudflare.mock_anchor_server import app

client = TestClient(app)

def run_a10_demonstration():
    print("=" * 70)
    print("CHAIN OF CUSTODY: ATTACK A10 & CLOUDFLARE PUBLIC ANCHOR DEMO")
    print("=" * 70)

    # Step 1: Normal system operation - Witness anchors legitimate chain heads
    print("\n[Step 1] Witness anchors legitimate chain head at seq=100...")
    legit_hash_100 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    resp = client.post(
        "/anchor",
        json={
            "seq": 100,
            "chain_head": legit_hash_100,
            "timestamp": "2026-10-14T10:00:00Z"
        },
        headers={"X-Witness-Key": "witness_genesis_public_key_or_secret"}
    )
    assert resp.status_code == 201, f"Failed to anchor: {resp.text}"
    print(f" -> Anchored successfully at seq=100: {resp.json()['chain_head'][:16]}...")

    # Step 2: Next anchor at seq=200
    print("\n[Step 2] Witness anchors next chain head at seq=200...")
    legit_hash_200 = "ca978112ca1bbdcafac231b39a23dc4da786081496608727a3c306d15a993717"
    resp = client.post(
        "/anchor",
        json={
            "seq": 200,
            "chain_head": legit_hash_200,
            "timestamp": "2026-10-14T10:05:00Z"
        },
        headers={"X-Witness-Key": "witness_genesis_public_key_or_secret"}
    )
    assert resp.status_code == 201
    print(f" -> Anchored successfully at seq=200: {resp.json()['chain_head'][:16]}...")

    # Step 3: Test Monotonicity Violation
    print("\n[Step 3] Attempting to overwrite past anchor at seq=100 (Backdating/Rewrite attempt)...")
    fake_hash = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
    resp = client.post(
        "/anchor",
        json={
            "seq": 100,
            "chain_head": fake_hash,
            "timestamp": "2026-10-14T10:06:00Z"
        },
        headers={"X-Witness-Key": "witness_genesis_public_key_or_secret"}
    )
    assert resp.status_code == 400
    print(f" [PASSED] Cloudflare Notary correctly rejected rewrite: {resp.json()['detail']}")

    # Step 4: Auditor verifies legitimate chain
    print("\n[Step 4] Auditor queries Cloudflare Notary to verify seq=100...")
    resp = client.get("/verify", params={"seq": 100, "hash": legit_hash_100})
    assert resp.status_code == 200
    data = resp.json()
    assert data["verified"] is True
    print(f" [VERIFIED] Local chain matches Cloudflare Public Notary: {data['verdict']}")

    # Step 5: Red Team executes Attack A10 (Compromised Witness rewrites history)
    print("\n[Step 5] RED TEAM ATTACK A10: Attacker compromises Witness and rewrites seq=100 locally...")
    local_tampered_hash_100 = "baadf00dbaadf00dbaadf00dbaadf00dbaadf00dbaadf00dbaadf00dbaadf00d"
    print(f" -> Attacker local rewritten hash: {local_tampered_hash_100[:16]}...")

    # Step 6: Auditor runs verification against Cloudflare Notary
    print("\n[Step 6] Auditor runs external verification against Cloudflare Notary...")
    resp = client.get("/verify", params={"seq": 100, "hash": local_tampered_hash_100})
    assert resp.status_code == 200
    data = resp.json()
    assert data["verified"] is False
    print(f" [ALERT TRIGGERED!] Verdict: {data['verdict']}")
    print(f"    Anchored Hash : {data['anchored_chain_head']}")
    print(f"    Submitted Hash: {data['submitted_hash']}")

    print("\n" + "=" * 70)
    print("DEMO SUMMARY: ATTACK A10 SUCCESSFULLY CAUGHT VIA CLOUDFLARE NOTARY!")
    print("=" * 70)

if __name__ == "__main__":
    run_a10_demonstration()
