"""Tests for the traffic simulator against a fake bank. Run: python -m unittest -v test_traffic_sim.py"""

import argparse
import io
import json
import os
import re
import tempfile
import threading
import unittest
from contextlib import redirect_stdout
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

_dir = tempfile.mkdtemp(prefix="coc-traffic-test-")
os.environ["COC_TRAFFIC_ENV"] = os.path.join(_dir, "sim.env")
os.environ["COC_TRAFFIC_STOP"] = os.path.join(_dir, "stop")

import traffic_sim as sim  # noqa: E402  (environment must be set before import)

PASSWORD_RULE = re.compile(r"^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':\"\\|,.<>/?]).{8,}$")
SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"


class FakeBank(BaseHTTPRequestHandler):
    """Enforces what the real bank enforces: password rules, mandatory 2FA, owner-only accounts,
    insufficient funds, a Secure session cookie, and a mix of 201 and 202 responses."""

    state = {}

    def log_message(self, *args):
        pass

    def _send(self, status, body, cookies=()):
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        for cookie in cookies:
            self.send_header("set-cookie", cookie)
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _json(self):
        length = int(self.headers.get("content-length") or 0)
        return json.loads(self.rfile.read(length) or b"{}")

    def _cookies(self):
        return dict(part.strip().split("=", 1) for part in (self.headers.get("cookie") or "").split(";") if "=" in part)

    def _authed(self):
        if self._cookies().get("banking_session") == self.state["session"]:
            return True
        self._send(401, {"error": "Access token required"})
        return False

    def do_GET(self):
        s = self.state
        if self.path.startswith("/api/transactions/witness-reconcile"):
            ids = [int(i) for i in self.path.split("=", 1)[1].split(",")]
            return self._send(200, {"transactions": [{"transaction_id": i} for i in ids if i in s["confirmed"]]})
        if not self._authed():
            return
        if self.path == "/api/accounts":
            return self._send(200, [{"id": a["id"], "balance": f"{a['balance']:.2f}", "account_type": a["type"]} for a in s["accounts"]])
        self._send(404, {"error": "not found"})

    def do_POST(self):
        s, body = self.state, self._json()
        s["calls"].append(self.path)
        if self.path == "/api/auth/register":
            if not PASSWORD_RULE.match(body.get("password", "")):
                return self._send(400, {"errors": ["password rules"]})
            s["user"] = body
            return self._send(201, {"twoFactor": {"status": "setup", "manualCode": " ".join(SECRET[i:i + 4] for i in range(0, len(SECRET), 4))}},
                              ["pending=1; HttpOnly; Secure"])
        if self.path == "/api/auth/login":
            user = s.get("user")
            if not user or body.get("email") != user["email"] or body.get("password") != user["password"]:
                return self._send(401, {"error": "Invalid email or password"})
            if s["expire_next_login"]:
                s["expire_next_login"] = False
            return self._send(200, {"twoFactor": {"status": "verify"}}, ["pending=1; HttpOnly; Secure"])
        if self.path == "/api/auth/two-factor/verify":
            if self._cookies().get("pending") != "1":
                return self._send(401, {"error": "No pending two-factor challenge"})
            if body.get("code") not in {sim.totp(SECRET, at=__import__("time").time() + d) for d in (-30, 0, 30)}:
                return self._send(400, {"error": "Invalid or expired OTP code"})
            s["session"] = f"token{len(s['calls'])}"
            return self._send(200, {"message": "ok"}, [f"banking_session={s['session']}; HttpOnly; Secure; SameSite=Strict", "pending=; Max-Age=0"])
        if not self._authed():
            return
        if self.path == "/api/accounts":
            account = {"id": len(s["accounts"]) + 1, "balance": Decimal("0.00"), "type": body["account_type"]}
            s["accounts"].append(account)
            return self._send(201, {"id": account["id"], "balance": "0.00", "account_type": account["type"]})
        by_id = {a["id"]: a for a in s["accounts"]}
        amount = Decimal(str(body["amount"]))
        if amount < Decimal("0.01") or amount != amount.quantize(Decimal("0.01")):
            return self._send(400, {"error": "Amount must be a positive number"})
        source = by_id.get(body.get("from_account_id") or body.get("account_id")) if self.path.endswith(("withdraw", "transfer", "outgoing")) else None
        target = by_id.get(body.get("to_account_id") or body.get("account_id")) if self.path.endswith(("deposit", "transfer")) else None
        if source is not None and source["balance"] < amount:
            return self._send(400, {"error": "Insufficient funds"})
        if source is not None:
            source["balance"] -= amount
        if target is not None:
            target["balance"] += amount
        s["next_id"] += 1
        txn = s["next_id"]
        s["amounts"].append((self.path.rsplit("/", 1)[1], amount))
        if txn % 5 == 0:
            return self._send(202, {"witness_status": "pending", "transaction": {"id": txn}})
        s["confirmed"].add(txn)
        self._send(201, {"witness_status": "confirmed", "transaction": {"id": txn}})


class TrafficTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeBank)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        sim.BANK_URL = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        FakeBank.state = {"accounts": [], "calls": [], "session": None, "confirmed": set(), "next_id": 100,
                          "amounts": [], "expire_next_login": False}
        for path in (sim.ENV_FILE, sim.STOP_FILE):
            if os.path.exists(path):
                os.remove(path)
        sim.Stop.requested = False

    def bank(self):
        return sim.Bank(sim.BANK_URL)

    def run_setup(self):
        output = io.StringIO()
        original = sim.Bank
        sim.Bank = lambda base=sim.BANK_URL: original(sim.BANK_URL)
        try:
            with redirect_stdout(output):
                sim.setup()
        finally:
            sim.Bank = original
        return output.getvalue()

    def test_totp_matches_the_rfc_6238_vector(self):
        # RFC 6238 appendix B: secret "12345678901234567890", time 59 s, SHA-1, 8 digits is 94287082.
        secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
        self.assertEqual(sim.totp(secret, at=59, digits=8), "94287082")
        self.assertEqual(sim.totp(secret, at=59), "287082")
        self.assertEqual(sim.totp(secret, at=1111111109, digits=8), "07081804")

    def test_setup_registers_enables_2fa_creates_three_accounts_and_funds_them(self):
        output = self.run_setup()
        env = sim.load_env()
        self.assertEqual({"SIM_USERNAME", "SIM_EMAIL", "SIM_PASSWORD", "SIM_TOTP_SECRET"}, set(env))
        self.assertEqual(env["SIM_TOTP_SECRET"], SECRET, "spaces in the displayed code are stripped")
        self.assertNotIn(env["SIM_PASSWORD"], output)
        self.assertNotIn(env["SIM_TOTP_SECRET"], output)
        if os.name == "posix":
            self.assertEqual(os.stat(sim.ENV_FILE).st_mode & 0o777, 0o600)
        accounts = FakeBank.state["accounts"]
        self.assertEqual(len(accounts), 3)
        self.assertTrue(all(a["balance"] == Decimal("1000.00") for a in accounts))

    def test_setup_twice_does_not_register_again(self):
        self.run_setup()
        registers = FakeBank.state["calls"].count("/api/auth/register")
        self.run_setup()
        self.assertEqual(FakeBank.state["calls"].count("/api/auth/register"), registers)
        self.assertEqual(len(FakeBank.state["accounts"]), 3)

    def test_run_creates_witnessed_traffic_without_overdrawing(self):
        self.run_setup()
        args = argparse.Namespace(max_count=40, duration=0, min_gap=0, max_gap=0)
        output = io.StringIO()
        with redirect_stdout(output):
            counts = sim.run(args, bank=self.bank(), sleep=lambda _s: None)
        self.assertEqual(counts["confirmed"] + counts["pending"], 40)
        self.assertGreater(counts["pending"], 0, "202 responses are counted, never retried")
        self.assertTrue(all(a["balance"] >= 0 for a in FakeBank.state["accounts"]))
        kinds = {kind for kind, _ in FakeBank.state["amounts"]}
        self.assertTrue({"transfer", "deposit"} <= kinds, kinds)
        self.assertNotIn(sim.load_env()["SIM_PASSWORD"], output.getvalue())
        self.assertIn("witness confirmed", output.getvalue())
        posts = [p for p in FakeBank.state["calls"] if p.startswith("/api/transactions")]
        self.assertEqual(len(posts), len(FakeBank.state["amounts"]), "no transaction request was repeated")

    def test_run_logs_in_again_after_the_session_expires(self):
        self.run_setup()
        bank = self.bank()
        args = argparse.Namespace(max_count=6, duration=0, min_gap=0, max_gap=0)
        original_call, calls = bank.call, {"n": 0}

        def flaky(method, path, body=None):
            calls["n"] += 1
            if calls["n"] == 8:
                FakeBank.state["session"] = "expired-elsewhere"  # the bank drops the session
            return original_call(method, path, body)

        bank.call = flaky
        with redirect_stdout(io.StringIO()):
            counts = sim.run(args, bank=bank, sleep=lambda _s: None)
        self.assertEqual(counts["confirmed"] + counts["pending"], 6)
        self.assertGreaterEqual(FakeBank.state["calls"].count("/api/auth/login"), 2)

    def test_stop_file_ends_the_run(self):
        self.run_setup()
        open(sim.STOP_FILE, "w").close()
        args = argparse.Namespace(max_count=50, duration=0, min_gap=0, max_gap=0)
        with redirect_stdout(io.StringIO()):
            # run() clears a stale stop file at start, so create it again from the sleep hook
            counts = sim.run(args, bank=self.bank(), sleep=lambda _s: open(sim.STOP_FILE, "w").close())
        self.assertLess(counts["confirmed"] + counts["pending"], 5)

    def test_choose_action_never_overdraws_or_picks_the_same_account_for_a_transfer(self):
        accounts = [{"id": 1, "balance": Decimal("250.00"), "type": "checking"},
                    {"id": 2, "balance": Decimal("5.00"), "type": "savings"},
                    {"id": 3, "balance": Decimal("4000.00"), "type": "business"}]
        for _ in range(400):
            kind, payload = sim.choose_action(accounts)
            if kind == "transfer":
                self.assertNotEqual(payload["from_account_id"], payload["to_account_id"])
            if kind in ("transfer", "withdraw", "external"):
                source = next(a for a in accounts if a["id"] == (payload.get("from_account_id") or payload.get("account_id")))
                self.assertGreaterEqual(source["balance"], sim.WITHDRAW_FLOOR)
                self.assertLessEqual(Decimal(payload["amount"]), source["balance"] * sim.MAX_FRACTION + Decimal("1.00"))

    def test_low_total_forces_a_deposit(self):
        accounts = [{"id": 1, "balance": Decimal("10.00"), "type": "checking"}, {"id": 2, "balance": Decimal("20.00"), "type": "savings"}]
        for _ in range(50):
            self.assertEqual(sim.choose_action(accounts)[0], "deposit")


if __name__ == "__main__":
    unittest.main()
