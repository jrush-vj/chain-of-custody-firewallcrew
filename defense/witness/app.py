"""Witness FastAPI app: heartbeat and checkpoint intake, history queries, silence sweep."""
import argparse
import asyncio
import logging
import sys
import threading
import time
import tomllib
from collections.abc import Callable
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import Body, FastAPI, Query
from fastapi.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from witness import checks, store

logger = logging.getLogger("witness")
ALERT_THROTTLE_S = 10
SWEEP_EVERY_S = 5.0
MAX_BODY_BYTES = 16 * 1024  # real heartbeats and checkpoints are under 1 KiB


class BodyLimit:
    """ASGI middleware: 413 for a declared body over MAX_BODY_BYTES; stop reading a longer chunked one."""

    def __init__(self, app: ASGIApp) -> None:
        """Wrap the inner ASGI app."""
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """Check Content-Length up front, then count the bytes actually received."""
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        length = dict(scope["headers"]).get(b"content-length", b"0")
        if not length.isdigit() or int(length) > MAX_BODY_BYTES:
            too_large = JSONResponse({"status": "invalid", "errors": ["body too large"]}, status_code=413)
            return await too_large(scope, receive, send)
        seen = 0

        async def limited() -> Message:
            """Pass body chunks through, stopping once the total is too large."""
            nonlocal seen
            msg = await receive()
            seen += len(msg.get("body", b""))
            if seen > MAX_BODY_BYTES:
                raise ValueError("request body too large")  # FastAPI turns this into a 400
            return msg

        await self.app(scope, limited, send)


def iso_utc(epoch: float) -> str:
    """Format an epoch time as YYYY-MM-DDTHH:MM:SSZ."""
    return datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def create_app(
    config_path: Path, now: Callable[[], float] = time.time, nodes_file: Path | None = None
) -> FastAPI:
    """Build the witness app from a profile; `now` is the witness clock, `nodes_file` overrides the profile."""
    with open(config_path, "rb") as f:
        config = tomllib.load(f)
    interval_s = float(config["heartbeat"]["interval_s"])
    nodes = checks.load_nodes(nodes_file or Path(config["witness"]["nodes_file"]))
    conn = store.connect(config["witness"]["db_path"])
    lock = threading.Lock()
    started_at = now()

    def record(node_id: str, alerts: list[dict[str, str]], epoch: float) -> None:
        """Store alerts, skipping an identical one stored in the last few seconds (flood guard)."""
        # Untrusted node_ids share one bucket, so random ids cannot bypass the throttle and fill the store.
        bucket = node_id if node_id in nodes else checks.UNKNOWN_NODE
        for a in alerts:
            if not store.alert_recorded_since(conn, bucket, a["code"], a["detail"], epoch - ALERT_THROTTLE_S):
                store.insert_alert(conn, bucket, a["code"], a["detail"], iso_utc(epoch), epoch)
                if bucket != node_id:
                    logger.warning("%s from unknown node_id %r", a["code"], node_id)

    def sweep_silence() -> list[dict[str, str]]:
        """Raise SILENCE for every trusted node that has gone quiet; return what was raised."""
        epoch, raised = now(), []
        with lock, store.write_transaction(conn):
            for node_id in nodes:
                alert = checks.silence_alert(conn, node_id, epoch, interval_s, started_at)
                if alert:
                    store.insert_alert(conn, node_id, alert["code"], alert["detail"], iso_utc(epoch), epoch)
                    raised.append({"node_id": node_id, **alert})
        return raised

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        """Run the periodic SILENCE sweep while the server is up."""
        async def loop() -> None:
            while True:
                await asyncio.sleep(SWEEP_EVERY_S)
                try:
                    await asyncio.to_thread(sweep_silence)
                except Exception:
                    logger.exception("silence sweep failed")
        task = asyncio.create_task(loop())
        try:
            yield
        finally:
            task.cancel()

    app = FastAPI(title="Chain of Custody witness", lifespan=lifespan)
    app.add_middleware(BodyLimit)
    app.state.conn, app.state.sweep_silence = conn, sweep_silence

    @app.post("/heartbeat")
    def post_heartbeat(body: Any = Body(...)) -> Any:
        """Accept a signed heartbeat; answer ok or the alerts it raised."""
        errors = checks.payload_errors(body, checks.HB_FIELDS)
        if errors:
            return JSONResponse({"status": "invalid", "errors": errors}, status_code=422)
        epoch = now()
        with lock, store.write_transaction(conn):
            if checks.signature_ok(nodes, body):
                alerts = checks.evaluate_heartbeat(conn, body)
                if not store.heartbeat_exists(conn, body["node_id"], body["hb_counter"], body["signature"]):
                    fresh = not any(a["code"] == "COUNTER_REPLAY" for a in alerts)
                    store.insert_heartbeat(conn, body, fresh, iso_utc(epoch), epoch)
            else:
                alerts = [checks.bad_signature_alert(nodes, body)]
            record(body["node_id"], alerts, epoch)
        return {"status": "alert", "alerts": alerts} if alerts else {"status": "ok"}

    @app.post("/checkpoint")
    def post_checkpoint(body: Any = Body(...)) -> Any:
        """Accept a signed checkpoint; reject it with 400 if the signature is not trusted."""
        errors = checks.payload_errors(body, checks.CP_FIELDS)
        if errors:
            return JSONResponse({"status": "invalid", "errors": errors}, status_code=422)
        epoch = now()
        with lock, store.write_transaction(conn):
            if not checks.signature_ok(nodes, body):
                alerts = [checks.bad_signature_alert(nodes, body)]
                record(body["node_id"], alerts, epoch)
                return JSONResponse({"status": "rejected", "alerts": alerts}, status_code=400)
            alerts, duplicate = checks.evaluate_checkpoint(conn, body)
            if not duplicate:
                store.insert_checkpoint(conn, body, iso_utc(epoch), epoch)
            record(body["node_id"], alerts, epoch)
        return {"status": "stored", "alerts": alerts} if alerts else {"status": "stored"}

    @app.get("/heartbeats")
    def get_heartbeats(node_id: str, limit: int | None = Query(None, ge=1, le=100000)) -> list[dict[str, Any]]:
        """List the newest stored heartbeats of a node, oldest first."""
        with lock:
            return store.list_rows(conn, "heartbeats", node_id, limit)

    @app.get("/checkpoints")
    def get_checkpoints(node_id: str, limit: int | None = Query(None, ge=1, le=100000)) -> list[dict[str, Any]]:
        """List the newest stored checkpoints of a node, oldest first."""
        with lock:
            return store.list_rows(conn, "checkpoints", node_id, limit)

    @app.get("/alerts")
    def get_alerts(
        node_id: str, code: str | None = None, limit: int | None = Query(None, ge=1, le=100000)
    ) -> list[dict[str, Any]]:
        """List the newest stored alerts of a node, optionally only one code."""
        with lock:
            return store.list_rows(conn, "alerts", node_id, limit, code)

    return app


def main(argv: list[str] | None = None) -> int:
    """CLI entry point: serve the witness on the profile's [witness] port."""
    import uvicorn

    parser = argparse.ArgumentParser(prog="python -m witness.app", description=__doc__)
    parser.add_argument("--config", type=Path, default=Path("config.toml"), help="profile configuration path")
    parser.add_argument("--host", default="127.0.0.1", help="bind address (use 0.0.0.0 in a container)")
    parser.add_argument("--nodes-file", type=Path, default=None, help="override [witness] nodes_file")
    args = parser.parse_args(argv)
    with open(args.config, "rb") as f:
        port = int(tomllib.load(f)["witness"]["port"])
    uvicorn.run(create_app(args.config, nodes_file=args.nodes_file), host=args.host, port=port)
    return 0


if __name__ == "__main__":
    sys.exit(main())
