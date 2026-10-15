"""Unit tests for the Layer 3 config guard and dry-run quarantine. Run: python -m unittest -v test_layer3.py"""

import io
import os
import re
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout

_dir = tempfile.mkdtemp(prefix="coc-l3-test-")
os.environ["COC_L3_STATE"] = os.path.join(_dir, "state")
os.environ["COC_BANK_ENV"] = os.path.join(_dir, "bank.env")
os.environ["COC_BANK_COMPOSE"] = os.path.join(_dir, "docker-compose.yml")

import l3_config_guard as guard  # noqa: E402  (environment must be set before import)
import l3_quarantine as l3  # noqa: E402

SECRET = "super-secret-value-that-must-never-be-printed"
ENV_TEXT = (
    "DB_PASSWORD=" + SECRET + "\n"
    "WITNESS_URL=https://witness.example.test\n"
    "JWT_SECRET=" + SECRET + "-jwt\n"
    "WITNESS_NODE_ID=ct105-ai\n"
    "WITNESS_HMAC_SECRET=" + SECRET + "-hmac\n"
)
COMPOSE_TEXT = "services:\n  backend:\n    ports:\n      - \"127.0.0.1:8081:8080\"\n"


def write(path, text):
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)


def read(path):
    with open(path, encoding="utf-8", newline="") as handle:
        return handle.read()


class ConfigGuardTests(unittest.TestCase):
    def setUp(self):
        self.env, self.compose = os.environ["COC_BANK_ENV"], os.environ["COC_BANK_COMPOSE"]
        write(self.env, ENV_TEXT)
        write(self.compose, COMPOSE_TEXT)
        guard.approve()

    def test_no_drift_right_after_approval(self):
        self.assertEqual(guard.drift(), [])

    def test_no_baseline_means_no_drift_report(self):
        os.remove(guard.paths()["baseline"])
        self.assertEqual(guard.drift(), [])
        self.assertIsNone(guard.load_baseline())

    def test_changed_witness_url_is_reported_and_restored_without_touching_other_lines(self):
        write(self.env, ENV_TEXT.replace("https://witness.example.test", "https://broken.invalid"))
        changes = guard.drift()
        self.assertEqual([c["item"] for c in changes], ["WITNESS_URL"])
        self.assertEqual(changes[0]["current"], "https://broken.invalid")
        self.assertEqual(guard.restore(), ["WITNESS_URL"])
        self.assertEqual(read(self.env), ENV_TEXT, "every other line must be byte-for-byte unchanged")
        self.assertEqual(guard.drift(), [])

    def test_changed_compose_is_reported_and_restored(self):
        write(self.compose, COMPOSE_TEXT.replace("8081", "9999"))
        self.assertEqual([c["item"] for c in guard.drift()], ["docker-compose.yml"])
        self.assertEqual(guard.restore(), ["docker-compose.yml"])
        self.assertEqual(read(self.compose), COMPOSE_TEXT)

    def test_removed_key_is_added_back(self):
        write(self.env, ENV_TEXT.replace("WITNESS_NODE_ID=ct105-ai\n", ""))
        self.assertEqual([c["item"] for c in guard.drift()], ["WITNESS_NODE_ID"])
        guard.restore()
        self.assertIn("WITNESS_NODE_ID=ct105-ai", read(self.env))
        self.assertEqual(guard.drift(), [])

    def test_restore_when_nothing_changed_does_nothing(self):
        self.assertEqual(guard.restore(), [])
        self.assertEqual(read(self.env), ENV_TEXT)

    def test_secrets_are_never_stored_or_printed(self):
        baseline = read(guard.paths()["baseline"])
        self.assertNotIn(SECRET, baseline)
        write(self.env, ENV_TEXT.replace("witness.example.test", "broken.invalid"))
        output = io.StringIO()
        with redirect_stdout(output):
            for change in guard.drift():
                print(change)
            sys.argv = ["l3_config_guard.py", "restore"]
            guard.main()
        self.assertNotIn(SECRET, output.getvalue())
        self.assertNotIn(SECRET, read(guard.paths()["baseline"]))


class QuarantineTests(unittest.TestCase):
    def setUp(self):
        self.real_run = subprocess.run
        self.commands = []

        def recording_run(command, *args, **kwargs):
            self.commands.append(command)
            return subprocess.CompletedProcess(command, 0, stdout="ubuntu pts/0\nroot pts/1\n", stderr="")

        l3.subprocess.run = recording_run

    def tearDown(self):
        l3.subprocess.run = self.real_run

    def test_dry_run_event_is_valid_for_the_witness(self):
        event = l3.run_dry("approved witness link settings changed: WITNESS_URL", now=1792000000)
        self.assertEqual(event["layer"], 3)
        self.assertEqual(event["trigger"], "quarantine:locked")
        self.assertRegex(event["trigger"], r"^[a-z0-9_:.-]{1,80}$")
        self.assertEqual(event["state"], "alert")
        self.assertLessEqual(len(event["summary"]), 200)
        self.assertEqual(event["who"], {})
        self.assertTrue(event["detail"]["dry_run"])
        self.assertLessEqual(len(event["detail"]), 20)
        for value in event["detail"].values():
            self.assertTrue(isinstance(value, (bool, int)) or (isinstance(value, str) and len(value) <= 4000))
        self.assertEqual(set(event), {"layer", "trigger", "state", "summary", "detail", "who"})

    def test_plan_lists_logout_and_restore_but_executes_nothing_but_who(self):
        event = l3.run_dry("no contact with the witness for 50 s", now=1792000001)
        actions = event["detail"]["lockout"].split("\n")
        joined = " ".join(actions + [event["detail"]["site_down"]])
        self.assertIn("log out every login session on ct105: 2 session(s)", joined)
        self.assertIn("log out every banking customer session", joined)
        self.assertIn("restore the approved witness link settings", joined)
        self.assertNotIn("reboot", joined)
        self.assertNotIn("shutdown", joined)
        self.assertNotIn("poweroff", joined)
        self.assertNotIn("halt", joined)
        self.assertNotIn("passwd", joined)
        self.assertNotIn("nologin", joined)
        self.assertEqual(self.commands, [["who"]], "only the read-only 'who' may run")

    def test_evidence_file_is_written(self):
        event = l3.run_dry("test", now=1792000002)
        self.assertTrue(os.path.exists(event["detail"]["evidence"]))


if __name__ == "__main__":
    unittest.main()
