"""Unit tests for the Layer 1 monitor. Run: python -m unittest -v test_monitor.py"""

import json
import os
import tempfile
import time
import unittest
import unittest.mock
import urllib.error
import urllib.request

_dir = tempfile.mkdtemp(prefix="coc-l1-test-")
os.environ.update({
    "WATCH_DIR": "/var/log/bank-demo",
    "STATE_DIR": _dir,
    "COMMANDS_SPOOL": os.path.join(_dir, "commands.jsonl"),
})
import monitor  # noqa: E402  (environment must be set before import)


def spool_line(command, args, user="ubuntu", cwd="/root"):
    return json.dumps({"ts": 1791993837.5, "command": command, "args": args,
                       "user": user, "cwd": cwd, "tty": "/dev/pts/0"})


def write_spool(lines):
    with open(monitor.COMMANDS_SPOOL, "w", encoding="utf-8", newline="\n") as handle:
        handle.write("\n".join(lines) + "\n")


class CommandTests(unittest.TestCase):
    def setUp(self):
        self.saved = monitor.WATCH_DIR
        monitor.WATCH_DIR = "/var/log/bank-demo"
        self.state = {"offset": 0}

    def tearDown(self):
        monitor.WATCH_DIR = self.saved

    def test_watched_command_becomes_alert_with_who_and_command(self):
        write_spool([spool_line("sed", "-i s/txn 2 ok/txn 2 ok (edited)/ /var/log/bank-demo/app.log", user="jrush")])
        events = monitor.read_new_commands(self.state)
        self.assertEqual(len(events), 1)
        event = events[0]
        self.assertEqual(event["trigger"], "command_executed")
        self.assertEqual(event["state"], "alert")
        self.assertEqual(event["detail"]["cmd"], "sed -i s/txn 2 ok/txn 2 ok (edited)/ /var/log/bank-demo/app.log")
        self.assertEqual(event["detail"]["cwd"], "/root")
        self.assertEqual(event["who"]["user"], "jrush")
        self.assertIn("jrush ran on the bank log", event["summary"])

    def test_command_not_on_the_bank_log_path_is_ignored(self):
        write_spool([spool_line("rm", "/tmp/unrelated.txt")])
        self.assertEqual(monitor.read_new_commands(self.state), [])

    def test_malformed_line_is_skipped(self):
        write_spool(["not json", spool_line("rm", "/var/log/bank-demo/app.log")])
        events = monitor.read_new_commands(self.state)
        self.assertEqual(len(events), 1)

    def test_offset_prevents_replaying_old_lines(self):
        write_spool([spool_line("rm", "/var/log/bank-demo/app.log")])
        first = monitor.read_new_commands(self.state)
        second = monitor.read_new_commands(self.state)
        self.assertEqual(len(first), 1)
        self.assertEqual(second, [])


class TripwireStatusTests(unittest.TestCase):
    def test_disarmed_without_profile_or_wrappers(self):
        saved = (monitor.PROFILE_FILE, monitor.TRIP_BIN)
        monitor.PROFILE_FILE = os.path.join(_dir, "missing-profile.sh")
        monitor.TRIP_BIN = os.path.join(_dir, "missing-bin")
        try:
            armed, count = monitor.tripwire_status()
        finally:
            monitor.PROFILE_FILE, monitor.TRIP_BIN = saved
        self.assertFalse(armed)
        self.assertEqual(count, 0)
        self.assertEqual(monitor.status_event(armed, count)["trigger"], "tripwire_disarmed")


class FileEventTests(unittest.TestCase):
    def setUp(self):
        self.saved = (monitor.WATCH_DIR, monitor.BASELINE_DIR)
        monitor.WATCH_DIR = os.path.join(_dir, "logs")
        monitor.BASELINE_DIR = os.path.join(_dir, "baseline")
        os.makedirs(monitor.BASELINE_DIR, exist_ok=True)
        os.makedirs(monitor.WATCH_DIR, exist_ok=True)

    def tearDown(self):
        monitor.WATCH_DIR, monitor.BASELINE_DIR = self.saved

    def test_file_event_carries_original_and_current_content(self):
        with open(os.path.join(monitor.BASELINE_DIR, "app.log"), "w", encoding="utf-8", newline="\n") as handle:
            handle.write("txn 1 ok\ntxn 2 ok\n")
        with open(os.path.join(monitor.WATCH_DIR, "app.log"), "w", encoding="utf-8", newline="\n") as handle:
            handle.write("txn 1 ok\ntxn 2 ok (edited)\n")
        approved = monitor.sha256_of(os.path.join(monitor.BASELINE_DIR, "app.log"))
        current = monitor.sha256_of(os.path.join(monitor.WATCH_DIR, "app.log"))
        event = monitor.file_event("app.log", approved, current, approved)
        self.assertEqual(event["state"], "alert")
        self.assertIn("txn 2 ok\n", event["detail"]["approved_content"])
        self.assertIn("(edited)", event["detail"]["current_content"])
        self.assertIn("-txn 2 ok", event["detail"]["diff"])

    def test_restore_to_approved_content_is_normal(self):
        with open(os.path.join(monitor.BASELINE_DIR, "app.log"), "w", encoding="utf-8", newline="\n") as handle:
            handle.write("txn 1 ok\n")
        approved = monitor.sha256_of(os.path.join(monitor.BASELINE_DIR, "app.log"))
        event = monitor.file_event("app.log", "changed-hash", approved, approved)
        self.assertEqual(event["state"], "normal")
        self.assertEqual(event["detail"]["result"], "restored")


class Layer3TriggerTests(unittest.TestCase):
    def setUp(self):
        self.saved = (monitor.config_guard.drift, monitor._last_contact, monitor.CUT_FLAG)

    def tearDown(self):
        monitor.config_guard.drift, monitor._last_contact, monitor.CUT_FLAG = self.saved

    def test_changed_witness_settings_trigger_layer3(self):
        monitor.config_guard.drift = lambda: [{"item": "WITNESS_URL"}, {"item": "docker-compose.yml"}]
        reason = monitor.layer3_trigger_reason()
        self.assertIn("WITNESS_URL", reason)
        self.assertIn("docker-compose.yml", reason)

    def test_silence_triggers_layer3_only_past_the_threshold(self):
        monitor.config_guard.drift = lambda: []
        monitor._last_contact = time.time() - (monitor.QUARANTINE_AFTER_S + 5)
        self.assertIn("no contact with the witness", monitor.layer3_trigger_reason())
        monitor._last_contact = time.time()
        self.assertIsNone(monitor.layer3_trigger_reason())

    def test_simulated_cut_fails_every_witness_request_without_touching_the_network(self):
        flag = os.path.join(_dir, "witness-cut")
        monitor.CUT_FLAG = flag
        request = urllib.request.Request("http://127.0.0.1:9/never-contacted")
        open(flag, "w").close()
        try:
            with self.assertRaises(urllib.error.URLError) as caught:
                monitor.open_witness(request, timeout=1)
            self.assertIn("simulated network cut", str(caught.exception))
        finally:
            os.remove(flag)


class Layer3ResponseTests(unittest.TestCase):
    """respond_to_layer3: the real lockout when it's safe to do, the dry run when it is not — and it
    must never raise, so an unsafe target can never crash the monitor's loop."""

    def setUp(self):
        self.saved_real = monitor.LAYER3_REAL_LOCKOUT

    def tearDown(self):
        monitor.LAYER3_REAL_LOCKOUT = self.saved_real

    def test_calls_the_real_lockout_when_enabled(self):
        monitor.LAYER3_REAL_LOCKOUT = True
        fake_event = {"layer": 3, "trigger": "quarantine:locked", "detail": {"dry_run": False}}
        with unittest.mock.patch.object(monitor.l3_lockout, "lock", return_value=(fake_event, True)) as lock:
            with unittest.mock.patch.object(monitor.l3_quarantine, "run_dry") as run_dry:
                event = monitor.respond_to_layer3("no contact with the witness for 50 s")
        lock.assert_called_once()
        run_dry.assert_not_called()
        self.assertEqual(event, fake_event)

    def test_falls_back_to_dry_run_when_the_demo_account_is_unsafe_or_missing(self):
        monitor.LAYER3_REAL_LOCKOUT = True
        with unittest.mock.patch.object(monitor.l3_lockout, "lock", side_effect=monitor.l3_lockout.UnsafeTarget("no such account")):
            event = monitor.respond_to_layer3("approved witness link settings changed: WITNESS_URL")
        self.assertEqual(event["detail"]["dry_run"], True)

    def test_uses_the_dry_run_when_real_lockout_is_switched_off(self):
        monitor.LAYER3_REAL_LOCKOUT = False
        with unittest.mock.patch.object(monitor.l3_lockout, "lock") as lock:
            event = monitor.respond_to_layer3("test reason")
        lock.assert_not_called()
        self.assertEqual(event["detail"]["dry_run"], True)


if __name__ == "__main__":
    unittest.main()
