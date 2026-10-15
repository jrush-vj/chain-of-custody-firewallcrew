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

    def test_restore_polling_keeps_quarantine_timer_quiet_during_120s_heartbeats(self):
        saved = (
            monitor.config_guard.drift,
            monitor._last_contact,
            monitor.signed_request,
            monitor.open_witness,
            monitor.HEARTBEAT_S,
            monitor.time,
        )
        clock = [1000.0]

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self):
                return b'{"pending":null}'

        try:
            monitor.config_guard.drift = lambda: []
            monitor._last_contact = clock[0]
            monitor.HEARTBEAT_S = 120
            monitor.time = type("Clock", (), {"time": staticmethod(lambda: clock[0])})
            monitor.signed_request = lambda *args: object()

            def poll(request, timeout=10):
                monitor._last_contact = clock[0]
                return Response()

            monitor.open_witness = poll
            self.assertEqual(monitor.RESTORE_CHECK_S, 5)
            for elapsed in range(5, 121, monitor.RESTORE_CHECK_S):
                clock[0] = 1000.0 + elapsed
                monitor.check_restore_request()
                self.assertIsNone(monitor.layer3_trigger_reason())
        finally:
            (
                monitor.config_guard.drift,
                monitor._last_contact,
                monitor.signed_request,
                monitor.open_witness,
                monitor.HEARTBEAT_S,
                monitor.time,
            ) = saved

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
    """Mode and confirmation select the response without exposing unlock keys in monitor logs."""

    def test_demo_mode_keeps_the_real_demo_account_response(self):
        with unittest.mock.patch.dict(os.environ, {"COC_L3_MODE": "demo"}, clear=False):
            with unittest.mock.patch.object(monitor.l3_lockout, "lock", return_value=({}, True)) as lock:
                with unittest.mock.patch.object(monitor.l3_quarantine, "run_dry") as run_dry:
                    event = monitor.respond_to_layer3("no contact with the witness for 50 s")
        lock.assert_called_once()
        run_dry.assert_not_called()
        self.assertEqual(event, {})

    def test_full_mode_calls_full_response_only_with_exact_confirmation(self):
        with unittest.mock.patch.dict(os.environ, {
            "COC_L3_MODE": "full",
            "COC_L3_FULL_CONFIRM": "I_UNDERSTAND_ROOT_LOCKOUT",
        }, clear=False):
            fake_event = {"layer": 3, "trigger": "quarantine:locked"}
            with unittest.mock.patch.object(
                monitor.l3_lockout, "full_lock", return_value=(fake_event, {"users": ["alice"]})
            ) as full_lock:
                with unittest.mock.patch.object(monitor.l3_quarantine, "run_dry") as run_dry:
                    event = monitor.respond_to_layer3("no contact with the witness for 50 s")
        full_lock.assert_called_once()
        run_dry.assert_not_called()
        self.assertEqual(event, fake_event)

    def test_full_mode_without_confirmation_refuses_and_reports_dry_run(self):
        with unittest.mock.patch.dict(os.environ, {"COC_L3_MODE": "full"}, clear=False):
            os.environ.pop("COC_L3_FULL_CONFIRM", None)
            fake_event = {"detail": {"dry_run": True}}
            with unittest.mock.patch.object(monitor.l3_lockout, "full_lock") as full_lock:
                with unittest.mock.patch.object(
                    monitor.l3_quarantine, "run_dry", return_value=fake_event
                ) as run_dry:
                    event = monitor.respond_to_layer3("test reason")
        full_lock.assert_not_called()
        run_dry.assert_called_once()
        self.assertEqual(event, fake_event)

    def test_demo_mode_falls_back_to_dry_run_when_target_is_missing(self):
        with unittest.mock.patch.dict(os.environ, {"COC_L3_MODE": "demo"}, clear=False):
            with unittest.mock.patch.object(
                monitor.l3_lockout, "lock", side_effect=monitor.l3_lockout.UnsafeTarget("no such account")
            ):
                event = monitor.respond_to_layer3("approved witness link settings changed: WITNESS_URL")
        self.assertEqual(event["detail"]["dry_run"], True)

    def test_invalid_mode_reports_dry_run(self):
        with unittest.mock.patch.dict(os.environ, {"COC_L3_MODE": "invalid"}, clear=False):
            with unittest.mock.patch.object(monitor.l3_quarantine, "run_dry", return_value={"dry": True}) as run_dry:
                event = monitor.respond_to_layer3("test reason")
        run_dry.assert_called_once()
        self.assertEqual(event, {"dry": True})

if __name__ == "__main__":
    unittest.main()
