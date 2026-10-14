"""
Local Mock Cloudflare Anchor Server (FastAPI)
Provides the identical API as the Cloudflare Worker Public Anchor.
Used for offline rehearsals, automated testing, and fallback.
"""

from fastapi import FastAPI, HTTPException, Header, Query
from pydantic import BaseModel
from typing import Optional
from datetime import datetime, timezone

app = FastAPI(title="Mock Cloudflare Anchor Notary", version="1.0.0")

# In-memory anchor store
anchors = {}
latest_seq = None
latest_anchor = None
EXPECTED_WITNESS_KEY = "witness_genesis_public_key_or_secret"

class AnchorRequest(BaseModel):
    seq: int
    chain_head: str
    timestamp: str
    signature: Optional[str] = None
    key_id: Optional[str] = None

@app.post("/anchor", status_code=201)
def post_anchor(payload: AnchorRequest, x_witness_key: Optional[str] = Header(None)):
    global latest_seq, latest_anchor

    # Optional auth check (can be relaxed for testing)
    if x_witness_key and x_witness_key != EXPECTED_WITNESS_KEY:
        raise HTTPException(status_code=401, detail="Unauthorized: Invalid witness key")

    # Check monotonicity
    if latest_seq is not None and payload.seq <= latest_seq:
        raise HTTPException(
            status_code=400,
            detail=f"Monotonicity violation: seq {payload.seq} <= latest anchored seq {latest_seq}. Cannot modify past anchors."
        )

    record = {
        "seq": payload.seq,
        "chain_head": payload.chain_head,
        "witness_timestamp": payload.timestamp,
        "signature": payload.signature,
        "key_id": payload.key_id,
        "edge_anchored_at": datetime.now(timezone.utc).isoformat(),
        "edge_colo": "MOCK-LOCAL"
    }

    anchors[payload.seq] = record
    latest_seq = payload.seq
    latest_anchor = record

    return {
        "status": "anchored",
        "seq": payload.seq,
        "chain_head": payload.chain_head,
        "edge_anchored_at": record["edge_anchored_at"],
        "edge_colo": "MOCK-LOCAL"
    }

@app.get("/anchor/latest")
def get_latest_anchor():
    if latest_anchor is None:
        raise HTTPException(status_code=404, detail="No anchors committed yet")
    return latest_anchor

@app.get("/anchor/{seq}")
def get_anchor_by_seq(seq: int):
    if seq not in anchors:
        raise HTTPException(status_code=404, detail=f"Anchor at seq {seq} not found")
    return anchors[seq]

@app.get("/verify")
def verify_hash(seq: int = Query(...), hash: str = Query(...)):
    if seq not in anchors:
        raise HTTPException(
            status_code=404,
            detail=f"Sequence {seq} is not anchored in mock Cloudflare public notary."
        )

    record = anchors[seq]
    is_match = record["chain_head"].lower() == hash.lower()

    return {
        "verified": is_match,
        "seq": seq,
        "anchored_chain_head": record["chain_head"],
        "submitted_hash": hash,
        "verdict": "VALID: Log matches external Cloudflare public notary." if is_match
                   else "TAMPER DETECTED: Local chain diverges from external Cloudflare public notary (Attack A10)!"
    }

@app.get("/")
def index():
    return {
        "service": "Mock Cloudflare Anchor Notary",
        "mode": "Offline Development / Test Fallback",
        "anchors_count": len(anchors),
        "latest_seq": latest_seq
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8787)
