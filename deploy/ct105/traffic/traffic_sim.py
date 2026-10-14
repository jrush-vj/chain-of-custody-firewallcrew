#!/usr/bin/env python3
"""Traffic simulator for the banking app on ct105: random transactions across one dedicated user's accounts.

Every transaction goes through the bank's real API, so each one is also witnessed (the app's two-phase
witness flow runs exactly as for a customer). It never touches the database directly, never uses other
users' accounts, and keeps the dedicated user's money circulating, so balances do not drain.

  python3 traffic_sim.py setup                 # once: register the 'traffic_sim' user, enable 2FA,
                                               # create 3 accounts, fund them (4 API calls to auth)
  python3 traffic_sim.py run [--max-count N] [--duration SECONDS] [--min-gap 12] [--max-gap 28]
  python3 traffic_sim.py stop                  # ask a running simulator to finish its current step and exit
  python3 traffic_sim.py status

Credentials live in a root-only file (default /root/.coc-traffic/sim.env, mode 600) and are never printed.
Rate: one transaction every 12-28 s (about 2-5 a minute). The bank allows 100 requests per 15 minutes per
address and 5 auth requests per 15 minutes, so this stays well inside both. Standard library only.

Environment: BANK_URL (default http://127.0.0.1:8081), COC_TRAFFIC_ENV, COC_TRAFFIC_STOP.
"""

import argparse
import base64
import hashlib
import hmac
import json
import os
import random
import secrets
import signal
import struct
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from decimal import Decimal

BANK_URL = os.environ.get("BANK_URL", "http://127.0.0.1:8081").rstrip("/")
ENV_FILE = os.environ.get("COC_TRAFFIC_ENV", "/root/.coc-traffic/sim.env")
STOP_FILE = os.environ.get("COC_TRAFFIC_STOP", "/tmp/traffic-sim.stop")

SESSION_REFRESH_S = 13 * 60       # sessions last 15 minutes; log in again before that
TARGET_TOTAL = Decimal("3000")    # deposit when the user's total falls below this
WITHDRAW_FLOOR = Decimal("200")   # never withdraw or pay out below this balance
MAX_FRACTION = Decimal("0.20")    # a single amount never exceeds this share of the source balance
MAX_CONSECUTIVE_FAILURES = 5
WEIGHTS = (("transfer", 40), ("deposit", 25), ("withdraw", 20), ("external", 15))


def log(message):
    print(f"{datetime.now().strftime('%H:%M:%S')} {message}", flush=True)


# ---------- TOTP (RFC 6238), because the bank enforces two-factor ----------

def totp(secret_b32, at=None, step=30, digits=6):
    cleaned = "".join(ch for ch in secret_b32.upper() if ch.isalnum())
    key = base64.b32decode(cleaned + "=" * (-len(cleaned) % 8))
    counter = int((time.time() if at is None else at) // step)
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = (struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF) % (10 ** digits)
    return f"{value:0{digits}d}"


# ---------- credentials file ----------

def load_env():
    values = {}
    try:
        with open(ENV_FILE, encoding="utf-8") as handle:
            for line in handle:
                key, separator, value = line.rstrip("\n").partition("=")
                if separator:
                    values[key.strip()] = value
    except OSError:
        pass
    return values


def save_env(values):
    os.makedirs(os.path.dirname(ENV_FILE), mode=0o700, exist_ok=True)
    descriptor = os.open(ENV_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        for key, value in values.items():
            handle.write(f"{key}={value}\n")


# ---------- the bank API ----------

class RateLimited(Exception):
    pass


class Bank:
    """Minimal client. Cookies are handled by hand: the session cookie may be marked Secure, which a
    standard cookie jar would refuse to send over plain http to 127.0.0.1."""

    def __init__(self, base=BANK_URL):
        self.base = base
        self.cookies = {}
        self.logged_in_at = 0.0

    def call(self, method, path, body=None):
        data = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {"content-type": "application/json", "accept": "application/json"}
        if self.cookies:
            headers["cookie"] = "; ".join(f"{name}={value}" for name, value in self.cookies.items())
        request = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                status, raw, set_cookies = response.status, response.read(), response.headers.get_all("Set-Cookie") or []
        except urllib.error.HTTPError as error:
            status, raw, set_cookies = error.code, error.read(), error.headers.get_all("Set-Cookie") or []
        for cookie in set_cookies:
            pair = cookie.split(";", 1)[0]
            name, _, value = pair.partition("=")
            expired = "max-age=0" in cookie.lower() or value == ""
            if expired:
                self.cookies.pop(name.strip(), None)
            else:
                self.cookies[name.strip()] = value
        try:
            parsed = json.loads(raw.decode("utf-8")) if raw else {}
        except ValueError:
            parsed = {"raw": raw.decode("utf-8", errors="replace")[:200]}
        return status, parsed

    def login(self, email, password, totp_secret):
        self.cookies.clear()
        status, body = self.call("POST", "/api/auth/login", {"email": email, "password": password})
        if status == 429:
            raise RateLimited("auth rate limit")
        if status != 200 or body.get("twoFactor", {}).get("status") != "verify":
            raise RuntimeError(f"login failed: HTTP {status} {str(body)[:120]}")
        status, body = self.call("POST", "/api/auth/two-factor/verify", {"code": totp(totp_secret)})
        if status == 429:
            raise RateLimited("auth rate limit")
        if status != 200:
            raise RuntimeError(f"two-factor verification failed: HTTP {status} {str(body)[:120]}")
        self.logged_in_at = time.time()

    def accounts(self):
        status, body = self.call("GET", "/api/accounts")
        if status != 200 or not isinstance(body, list):
            raise RuntimeError(f"could not list accounts: HTTP {status}")
        return [{"id": int(a["id"]), "balance": Decimal(str(a["balance"])), "type": a.get("account_type", "")} for a in body]


# ---------- setup ----------

def setup():
    env = load_env()
    bank = Bank()
    if env.get("SIM_TOTP_SECRET"):
        log(f"already set up for {env['SIM_EMAIL']}; logging in to check the accounts")
    else:
        suffix = secrets.token_hex(3)
        env = {
            "SIM_USERNAME": f"traffic_sim_{suffix}",
            "SIM_EMAIL": f"traffic.sim.{suffix}@example.com",
            # Meets the bank's password rules: upper, lower, digit, special, 8+ characters.
            "SIM_PASSWORD": "Ts1!" + secrets.token_urlsafe(18),
        }
        status, body = bank.call("POST", "/api/auth/register",
                                 {"username": env["SIM_USERNAME"], "email": env["SIM_EMAIL"], "password": env["SIM_PASSWORD"]})
        if status != 201:
            raise SystemExit(f"register failed: HTTP {status} {str(body)[:160]}")
        secret = body.get("twoFactor", {}).get("manualCode", "")
        if not secret:
            raise SystemExit("the bank did not return a two-factor secret")
        env["SIM_TOTP_SECRET"] = "".join(ch for ch in secret if ch.isalnum())
        save_env(env)  # saved before anything else, so the secret can never be lost
        log(f"registered {env['SIM_USERNAME']}; credentials saved to {ENV_FILE} (mode 600)")
        status, body = bank.call("POST", "/api/auth/two-factor/verify", {"code": totp(env["SIM_TOTP_SECRET"])})
        if status != 200:
            raise SystemExit(f"two-factor setup failed: HTTP {status} {str(body)[:160]}")
        bank.logged_in_at = time.time()
        log("two-factor enabled")

    if not bank.cookies:
        bank.login(env["SIM_EMAIL"], env["SIM_PASSWORD"], env["SIM_TOTP_SECRET"])
    existing = bank.accounts()
    for kind in ("checking", "savings", "business"):
        if len(existing) >= 3:
            break
        status, body = bank.call("POST", "/api/accounts", {"account_type": kind})
        if status != 201:
            raise SystemExit(f"could not create a {kind} account: HTTP {status} {str(body)[:120]}")
        existing.append({"id": int(body["id"]), "balance": Decimal(str(body.get("balance", 0))), "type": kind})
        log(f"created {kind} account #{body['id']}")
    for account in bank.accounts():
        if account["balance"] < Decimal("1000"):
            status, body = bank.call("POST", "/api/transactions/deposit", {"account_id": account["id"], "amount": "1000.00"})
            log(f"funded account #{account['id']} with 1000.00: HTTP {status}")
    log("setup complete. Start traffic with: python3 traffic_sim.py run")


# ---------- the traffic loop ----------

def decimal_amount(low, high):
    return Decimal(str(round(random.uniform(float(low), float(high)), 2))).quantize(Decimal("0.01"))


def choose_action(accounts):
    """(kind, payload) for one transaction, or None when nothing sensible can be done."""
    total = sum(a["balance"] for a in accounts)
    spendable = [a for a in accounts if a["balance"] >= WITHDRAW_FLOOR]
    kind = random.choices([k for k, _ in WEIGHTS], [w for _, w in WEIGHTS])[0]
    if total < TARGET_TOTAL or not spendable:
        kind = "deposit"
    if kind == "deposit":
        target = random.choice(accounts)
        return "deposit", {"account_id": target["id"], "amount": f"{decimal_amount(20, 300)}"}
    source = random.choice(spendable)
    cap = max(Decimal("1.00"), (source["balance"] * MAX_FRACTION).quantize(Decimal("0.01")))
    amount = f"{decimal_amount(1, min(float(cap), 250))}"
    if kind == "transfer":
        others = [a for a in accounts if a["id"] != source["id"]]
        return "transfer", {"from_account_id": source["id"], "to_account_id": random.choice(others)["id"], "amount": amount}
    if kind == "withdraw":
        return "withdraw", {"account_id": source["id"], "amount": amount}
    return "external", {"from_account_id": source["id"], "recipient_name": "SIM Recipient",
                        "recipient_iban": "DE89370400440532013000", "amount": amount, "reference": f"SIM-{int(time.time())}"}


ROUTES = {"transfer": "/api/transactions/transfer", "deposit": "/api/transactions/deposit",
          "withdraw": "/api/transactions/withdraw", "external": "/api/transactions/external/outgoing"}


class Stop:
    requested = False


def run(args, bank=None, sleep=time.sleep):
    env = load_env()
    if not env.get("SIM_TOTP_SECRET"):
        raise SystemExit("not set up yet: run 'python3 traffic_sim.py setup' first")
    bank = bank or Bank()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, lambda *_: setattr(Stop, "requested", True))
        except ValueError:
            pass  # not in the main thread (tests)
    if os.path.exists(STOP_FILE):
        os.remove(STOP_FILE)

    started, done, failures = time.time(), 0, 0
    counts = {"confirmed": 0, "pending": 0, "skipped": 0, "errors": 0}
    ids = []
    log(f"traffic started against {bank.base}; stop with 'python3 traffic_sim.py stop' or Ctrl-C")
    while not Stop.requested and not os.path.exists(STOP_FILE):
        if args.max_count and done >= args.max_count:
            break
        if args.duration and time.time() - started >= args.duration:
            break
        try:
            if time.time() - bank.logged_in_at > SESSION_REFRESH_S or not bank.cookies:
                bank.login(env["SIM_EMAIL"], env["SIM_PASSWORD"], env["SIM_TOTP_SECRET"])
                log("logged in")
            accounts = bank.accounts()
            action = choose_action(accounts) if len(accounts) >= 2 else None
            if action is None:
                raise RuntimeError("the simulator needs at least two accounts; run setup")
            kind, payload = action
            status, body = bank.call("POST", ROUTES[kind], payload)
            txn = (body.get("transaction") or {}).get("id")
            amount = payload["amount"]
            if status in (201, 202):
                counts["confirmed" if status == 201 else "pending"] += 1
                done, failures = done + 1, 0
                if txn:
                    ids.append(int(txn))
                log(f"{kind:<8} {amount:>8}  {'confirmed' if status == 201 else 'pending (recorded; the bank will confirm it)'}  txn #{txn}")
            elif status == 400:
                counts["skipped"] += 1
                log(f"{kind:<8} {amount:>8}  skipped: {str(body.get('error', body))[:80]}")
            elif status == 401:
                bank.cookies.clear()
                log("session expired; logging in again next round")
            elif status == 429:
                log("rate limited by the bank; pausing 120 s")
                sleep(120)
            else:
                raise RuntimeError(f"HTTP {status} {str(body)[:100]}")
        except RateLimited:
            log("auth rate limit; pausing 6 minutes")
            sleep(360)
        except (RuntimeError, urllib.error.URLError, OSError) as error:
            counts["errors"] += 1
            failures += 1
            log(f"error ({failures}/{MAX_CONSECUTIVE_FAILURES}): {error}")
            if failures >= MAX_CONSECUTIVE_FAILURES:
                log("too many consecutive failures; stopping")
                break
            sleep(min(300, 15 * 2 ** failures))
            continue
        sleep(random.uniform(args.min_gap, args.max_gap))

    log(f"finished: {counts['confirmed']} confirmed, {counts['pending']} pending, "
        f"{counts['skipped']} skipped, {counts['errors']} errors")
    verify(bank, ids[-100:])
    return counts


def verify(bank, ids):
    """Ask the bank's reconcile endpoint how many of the last transactions the witness has confirmed."""
    if not ids:
        return
    status, body = bank.call("GET", "/api/transactions/witness-reconcile?transaction_ids=" + ",".join(str(i) for i in ids))
    if status == 200:
        seen = {int(t["transaction_id"]) for t in body.get("transactions", [])}
        log(f"witness confirmed {len(seen)} of the last {len(ids)} transactions"
            + ("" if len(seen) == len(ids) else " (the rest are still pending and are retried by the bank every 10 s)"))


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("setup")
    sub.add_parser("stop")
    sub.add_parser("status")
    runner = sub.add_parser("run")
    runner.add_argument("--max-count", type=int, default=0)
    runner.add_argument("--duration", type=float, default=0)
    runner.add_argument("--min-gap", type=float, default=12)
    runner.add_argument("--max-gap", type=float, default=28)
    args = parser.parse_args()
    if args.command == "setup":
        setup()
    elif args.command == "run":
        run(args)
    elif args.command == "stop":
        open(STOP_FILE, "w").close()
        log(f"stop requested ({STOP_FILE}); the simulator exits after its current step")
    else:
        env = load_env()
        log(f"set up as {env['SIM_EMAIL']}" if env.get("SIM_EMAIL") else "not set up yet")


if __name__ == "__main__":
    main()
