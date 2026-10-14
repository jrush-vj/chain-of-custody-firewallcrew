"""The monitor's heartbeat with the bank view, against a fake witness. Run: python -m unittest -v test_monitor_sync.py"""

import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout

_dir = tempfile.mkdtemp(prefix="coc-sync-test-")
os.environ.update({
    "WATCH_DIR": "/var/log/bank-demo",
    "STATE_DIR": _dir,
    "COMMANDS_SPOOL": os.path.join(_dir, "commands.jsonl"),
    "WITNESS_URL": "http://witness.invalid",
    "WITNESS_NODE_ID": "test-node",
    "WITNESS_HMAC_SECRET": "test-secret-value-at-least-32-characters",
})
import monitor  # noqa: E402  (environment must be set before import)

ROWS = {i: {"id": i, "type": "deposit", "amount": f"{i * 100}.00", "status": "completed",
            "from_account_id": None, "to_account_id": i, "timestamp": f"2026-10-14 10:00:{i:02d}"} for i in range(1, 6)}


class FakeResponse:
    def __init__(self, body):
        self.body = json.dumps(body).encode()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self):
        return self.body


class FakeWitness:
    """Records every request and answers like the real witness would."""

    def __init__(self, heartbeat_reply):
        self.requests = []
        self.heartbeat_reply = heartbeat_reply
        self.stored = {}

    def __call__(self, request, timeout=10):
        path = request.full_url.replace("http://witness.invalid", "")
        body = json.loads(request.data.decode()) if request.data else {}
        self.requests.append((path, body))
        if path == "/v1/heartbeat":
            return FakeResponse(self.heartbeat_reply)
        for row in body["rows"]:
            self.stored[row["id"]] = row
        return FakeResponse({"stored_count": len(self.stored), "stored_max_id": max(self.stored), "need_rows": []})


class HeartbeatSyncTests(unittest.TestCase):
    def setUp(self):
        self.saved = (monitor.open_witness, monitor.bank_reader.build_view, monitor.bank_reader.rows_by_ids,
                      monitor._sweep_position, monitor._bank_error_logged_at, monitor.BANK_SYNC)
        monitor._sweep_position, monitor._bank_error_logged_at, monitor.BANK_SYNC = 0, 0.0, True
        monitor.bank_reader.rows_by_ids = lambda ids: [ROWS[i] for i in ids if i in ROWS]
        monitor.bank_reader.build_view = lambda position: (
            {"count": 5, "max_id": 5, "ranges": "1-5", "sweep": []}, 3)

    def tearDown(self):
        (monitor.open_witness, monitor.bank_reader.build_view, monitor.bank_reader.rows_by_ids,
         monitor._sweep_position, monitor._bank_error_logged_at, monitor.BANK_SYNC) = self.saved

    def run_beat(self, witness):
        monitor.open_witness = witness
        with redirect_stdout(io.StringIO()) as output:
            result = monitor.send_heartbeat()
        return result, output.getvalue()

    def test_the_heartbeat_carries_the_bank_view_and_the_rotation_advances(self):
        witness = FakeWitness({"status": "ok", "sync": {"need_rows": []}})
        result, _ = self.run_beat(witness)
        self.assertTrue(result)
        path, body = witness.requests[0]
        self.assertEqual(path, "/v1/heartbeat")
        self.assertEqual(body["bank"], {"count": 5, "max_id": 5, "ranges": "1-5", "sweep": []})
        self.assertGreater(body["seq"], 0)
        self.assertEqual(monitor._sweep_position, 3)

    def test_rows_the_witness_asks_for_are_sent_and_nothing_else(self):
        witness = FakeWitness({"status": "ok", "sync": {"need_rows": [2, 4]}})
        result, output = self.run_beat(witness)
        self.assertTrue(result)
        posts = [r for r in witness.requests if r[0] == "/v1/records"]
        self.assertEqual(len(posts), 1)
        self.assertEqual([row["id"] for row in posts[0][1]["rows"]], [2, 4])
        self.assertEqual(set(witness.stored), {2, 4})
        self.assertIn("sent 2 bank row(s)", output)

    def test_a_large_request_is_split_into_rounds_of_at_most_forty_rows(self):
        monitor.bank_reader.rows_by_ids = lambda ids: [{**ROWS[1], "id": i} for i in ids]
        witness = FakeWitness({"status": "ok", "sync": {"need_rows": list(range(1, 101))}})
        original_call = witness.__call__

        def paged(request, timeout=10):
            response = original_call(request, timeout)
            if request.full_url.endswith("/v1/records"):
                remaining = [i for i in range(1, 101) if i not in witness.stored]
                return FakeResponse({"stored_count": len(witness.stored), "need_rows": remaining})
            return response

        monitor.open_witness = paged
        with redirect_stdout(io.StringIO()):
            monitor.send_heartbeat()
        sizes = [len(body["rows"]) for path, body in witness.requests if path == "/v1/records"]
        self.assertTrue(all(size <= 40 for size in sizes), sizes)
        self.assertEqual(len(witness.stored), 100)

    def test_the_heartbeat_still_goes_out_when_the_database_cannot_be_read(self):
        def unreadable(position):
            raise monitor.bank_reader.BankReadError("permission denied")

        monitor.bank_reader.build_view = unreadable
        witness = FakeWitness({"status": "ok"})
        result, output = self.run_beat(witness)
        self.assertTrue(result, "a missed heartbeat is an alert, so the database must never hold it up")
        self.assertNotIn("bank", witness.requests[0][1])
        self.assertIn("bank view unavailable", output)
        # The warning is rate-limited, not repeated every 30 seconds.
        _, second = self.run_beat(FakeWitness({"status": "ok"}))
        self.assertNotIn("bank view unavailable", second)

    def test_bank_sync_can_be_switched_off(self):
        monitor.BANK_SYNC = False
        witness = FakeWitness({"status": "ok"})
        self.run_beat(witness)
        self.assertNotIn("bank", witness.requests[0][1])

    def test_a_rejected_view_is_logged_and_the_heartbeat_still_counts(self):
        witness = FakeWitness({"status": "ok", "sync_error": "bank.ranges does not add up to bank.count"})
        result, output = self.run_beat(witness)
        self.assertTrue(result)
        self.assertIn("the witness rejected the bank view", output)


if __name__ == "__main__":
    unittest.main()
