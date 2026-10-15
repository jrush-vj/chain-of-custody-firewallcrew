"""Tests for the real, scoped Layer 3 lockout. The safety-guard tests are the ones that matter most:
no input, environment variable, or trigger condition may ever make this touch root or the account
running it. Run: python -m unittest -v test_l3_lockout.py
"""

import hashlib
import io
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import types
import unittest
from contextlib import redirect_stdout
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "layer1"))

_dir = tempfile.mkdtemp(prefix="coc-l3-lockout-test-")
os.environ["COC_L3_STATE"] = _dir

import l3_lockout  # noqa: E402
import demo_keys  # noqa: E402


def fake_pwent(name, uid):
    return types.SimpleNamespace(pw_name=name, pw_uid=uid)


class SafetyGuardTests(unittest.TestCase):
    """resolve_demo_user() is the single choke point every real action goes through. These prove it
    refuses root, the operator's own account, and anything that is not a normal demo-range uid —
    regardless of what COC_DEMO_USER is set to."""

    def test_refuses_root_even_if_asked_for(self):
        with mock.patch.dict(os.environ, {"COC_DEMO_USER": "root"}):
            with self.assertRaises(l3_lockout.UnsafeTarget):
                l3_lockout.resolve_demo_user()

    def test_refuses_the_account_running_the_script(self):
        with mock.patch("l3_lockout.getpass.getuser", return_value="whoeveriam"):
            with mock.patch.dict(os.environ, {"COC_DEMO_USER": "whoeveriam"}):
                with self.assertRaises(l3_lockout.UnsafeTarget):
                    l3_lockout.resolve_demo_user()

    def test_refuses_a_system_account_uid(self):
        with mock.patch("l3_lockout.pwd.getpwnam", return_value=fake_pwent("www-data", 33)):
            with mock.patch.dict(os.environ, {"COC_DEMO_USER": "www-data"}):
                with self.assertRaises(l3_lockout.UnsafeTarget):
                    l3_lockout.resolve_demo_user()

    def test_refuses_an_unknown_account_rather_than_defaulting_to_anything(self):
        with mock.patch("l3_lockout.pwd.getpwnam", side_effect=KeyError()):
            with self.assertRaises(l3_lockout.UnsafeTarget):
                l3_lockout.resolve_demo_user()

    def test_accepts_a_real_demo_account(self):
        with mock.patch("l3_lockout.getpass.getuser", return_value="root"):
            with mock.patch("l3_lockout.pwd.getpwnam", return_value=fake_pwent("coc-demo-intruder", 1500)):
                name, uid = l3_lockout.resolve_demo_user()
        self.assertEqual((name, uid), ("coc-demo-intruder", 1500))

    def test_lock_refuses_before_touching_the_system_when_the_target_is_unsafe(self):
        with mock.patch("l3_lockout.pwd.getpwnam", side_effect=KeyError()):
            with mock.patch("l3_lockout.end_sessions") as end, mock.patch("l3_lockout.disable_login") as disable:
                with self.assertRaises(l3_lockout.UnsafeTarget):
                    l3_lockout.lock("test")
                end.assert_not_called()
                disable.assert_not_called()

    def test_unlock_refuses_before_touching_the_system_when_keys_are_wrong(self):
        with mock.patch("l3_lockout.enable_login") as enable:
            event, ok = l3_lockout.unlock(["wrong", "also wrong"])
            self.assertIsNone(event)
            self.assertFalse(ok)
            enable.assert_not_called()


class SessionEndingTests(unittest.TestCase):
    """login_sessions_of / end_sessions against a fake /proc, proving self-exclusion and uid scoping."""

    def make_proc(self, procs):
        """procs: {pid: (ppid, uid, tty, auid_or_None)}"""
        root = tempfile.mkdtemp(dir=_dir)
        for pid, (ppid, uid, tty, auid) in procs.items():
            d = os.path.join(root, str(pid))
            os.makedirs(d)
            with open(os.path.join(d, "stat"), "w") as handle:
                handle.write(f"{pid} (bash) S {ppid} {pid} {pid} {tty} -1 0 0 0 0 0 0 0 0 0\n")
            with open(os.path.join(d, "status"), "w") as handle:
                handle.write(f"Name:\tbash\nUid:\t{uid}\t{uid}\t{uid}\t{uid}\n")
            if auid is not None:
                with open(os.path.join(d, "loginuid"), "w") as handle:
                    handle.write(str(auid))
        return root

    def test_finds_only_the_target_uids_session_processes(self):
        demo_uid, other_uid = 1500, 1501
        procs = {
            100: (1, demo_uid, 4, None),       # demo account, has a tty: a session
            101: (100, demo_uid, 0, 1500),     # demo account, auid set: also a session (e.g. a cron-less login)
            102: (1, demo_uid, 0, None),       # demo account, no tty, no auid: a background process, not a session
            200: (1, other_uid, 5, None),      # a different account entirely
        }
        with mock.patch("l3_lockout.os.getpid", return_value=999999):
            root = self.make_proc(procs)
            found = l3_lockout.login_sessions_of(demo_uid, proc_root=root)
        self.assertEqual(sorted(item["pid"] for item in found), [100, 101])

    def test_never_includes_this_process_or_its_ancestors(self):
        demo_uid = 1500
        procs = {
            50: (1, demo_uid, 3, None),     # our own shell's ancestor, running as the demo uid by coincidence
            60: (50, demo_uid, 0, None),    # this script's own pid, child of 50
            70: (1, demo_uid, 7, None),     # an unrelated session for the same uid: must still be found
        }
        root = self.make_proc(procs)
        with mock.patch("l3_lockout.os.getpid", return_value=60):
            found = l3_lockout.login_sessions_of(demo_uid, proc_root=root)
        pids = [item["pid"] for item in found]
        self.assertNotIn(50, pids, "ancestor of this process must never be targeted")
        self.assertNotIn(60, pids, "this process itself must never be targeted")
        self.assertIn(70, pids, "an unrelated session for the same uid must still be found")

    def test_end_sessions_kills_what_it_finds_and_reports_failures(self):
        with mock.patch("l3_lockout.login_sessions_of", return_value=[{"pid": 111, "cmd": "bash"}, {"pid": 222, "cmd": "bash"}]):
            with mock.patch("l3_lockout.os.kill", side_effect=[None, PermissionError()]) as kill:
                result = l3_lockout.end_sessions(1500)
        self.assertEqual(kill.call_count, 2)
        self.assertTrue(result[0]["killed"])
        self.assertFalse(result[1]["killed"])
        self.assertEqual(result[1]["error"], "PermissionError")

    def test_full_session_scan_handles_multiple_uids_and_skips_monitor_ancestors(self):
        procs = {
            50: (1, 4242, 4, None),    # monitor parent; must never be killed
            60: (50, 0, 0, 4242),      # monitor process; must never be killed
            70: (1, 0, 7, None),       # independent root login
            80: (1, 1500, 8, None),    # independent user login
        }
        root = self.make_proc(procs)
        with mock.patch("l3_lockout.os.getpid", return_value=60):
            found = l3_lockout.login_sessions_of([0, 1500], proc_root=root)
        self.assertEqual(sorted(item["pid"] for item in found), [70, 80])


class CommandResultTests(unittest.TestCase):
    def test_run_returns_json_safe_result_fields(self):
        completed = mock.Mock(returncode=2, stdout="out", stderr="failed")
        with mock.patch("l3_lockout.subprocess.run", return_value=completed):
            result = l3_lockout.run(["example", "arg"])
        self.assertEqual(result, {
            "cmd": ["example", "arg"],
            "ran": True,
            "rc": 2,
            "out": "out",
            "error": "failed",
        })

    def test_run_reports_missing_command_as_failure(self):
        with mock.patch("l3_lockout.subprocess.run", side_effect=FileNotFoundError("missing")):
            result = l3_lockout.run(["missing"])
        self.assertEqual(result["rc"], 127)
        self.assertFalse(result["ran"])
        self.assertIn("missing", result["error"])


class LockUnlockEventTests(unittest.TestCase):
    """The layer-3 events lock()/unlock() build, with every system call mocked."""

    def setUp(self):
        patches = [
            mock.patch("l3_lockout.pwd.getpwnam", return_value=fake_pwent("coc-demo-intruder", 1500)),
            mock.patch("l3_lockout.getpass.getuser", return_value="root"),
            mock.patch("l3_lockout.end_sessions", return_value=[{"pid": 111, "cmd": "bash", "killed": True}]),
            mock.patch("l3_lockout.disable_login", return_value=(True, [])),
            mock.patch("l3_lockout.enable_login", return_value=(True, [])),
            mock.patch("l3_lockout.l3_quarantine.login_session_count", return_value=0),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    def test_lock_event_says_this_was_real_for_the_demo_account(self):
        event, ok = l3_lockout.lock("no contact with the witness for 50 s", now=1792000000)
        self.assertTrue(ok)
        self.assertEqual(event["layer"], 3)
        self.assertEqual(event["trigger"], "quarantine:locked")
        self.assertEqual(event["state"], "alert")
        self.assertEqual(event["detail"]["dry_run"], False)
        self.assertEqual(event["detail"]["demo_account"], "coc-demo-intruder")
        self.assertIn("coc-demo-intruder", event["detail"]["lockout"])
        self.assertIn("REAL:", event["detail"]["lockout"])
        self.assertLessEqual(len(event["summary"]), 200)

    def test_unlock_event_needs_two_correct_keys(self):
        keys = list(demo_keys.DEMO_KEYS.values())
        event, ok = l3_lockout.unlock(keys[:2], now=1792000100)
        self.assertTrue(ok)
        self.assertEqual(event["trigger"], "quarantine:released")
        self.assertEqual(event["state"], "normal")
        self.assertEqual(event["detail"]["demo_account"], "coc-demo-intruder")

    def test_unlock_with_only_one_correct_key_is_refused(self):
        keys = [list(demo_keys.DEMO_KEYS.values())[0], "not a real key"]
        event, ok = l3_lockout.unlock(keys, now=1792000200)
        self.assertIsNone(event)
        self.assertFalse(ok)

    def test_a_repeated_correct_key_does_not_count_twice(self):
        key = list(demo_keys.DEMO_KEYS.values())[0]
        event, ok = l3_lockout.unlock([key, key], now=1792000300)
        self.assertIsNone(event)
        self.assertFalse(ok, "the same key submitted twice must not satisfy the 2-of-3 requirement")


class DemoKeyTests(unittest.TestCase):
    def test_any_two_distinct_correct_keys_verify(self):
        keys = list(demo_keys.DEMO_KEYS.values())
        self.assertTrue(demo_keys.verify([keys[0], keys[1]]))
        self.assertTrue(demo_keys.verify([keys[0], keys[2], "junk"]))

    def test_one_correct_key_is_not_enough(self):
        keys = list(demo_keys.DEMO_KEYS.values())
        self.assertFalse(demo_keys.verify([keys[0]]))
        self.assertFalse(demo_keys.verify([keys[0], "wrong"]))

    def test_wrong_keys_never_verify(self):
        self.assertFalse(demo_keys.verify(["a", "b", "c"]))
        self.assertFalse(demo_keys.verify([]))

    def test_holder_for_key_identifies_the_right_holder(self):
        for holder, key in demo_keys.DEMO_KEYS.items():
            self.assertEqual(demo_keys.holder_for_key(key), holder)
        self.assertIsNone(demo_keys.holder_for_key("not a key"))


class FullLockoutTests(unittest.TestCase):
    def setUp(self):
        self.state_dir = tempfile.mkdtemp(prefix="coc-l3-full-")
        self.hashes_path = os.path.join(self.state_dir, "unlock-key-hashes.json")
        self.state_patch = mock.patch.multiple(
            l3_lockout,
            STATE_DIR=self.state_dir,
            UNLOCK_HASHES_FILE=self.hashes_path,
        )
        self.state_patch.start()
        self.addCleanup(self.state_patch.stop)
        self.monitor_patch = mock.patch.object(l3_lockout, "monitor_account", return_value="coc-monitor")
        self.monitor_patch.start()
        self.addCleanup(self.monitor_patch.stop)

    def full_environment(self):
        return mock.patch.dict(os.environ, {
            "COC_L3_MODE": "full",
            "COC_L3_FULL_CONFIRM": l3_lockout.FULL_CONFIRMATION,
            "COC_L3_BREAK_GLASS_ACCOUNT": "coc-break-glass",
            "COC_KEEP_ACCOUNTS": "coc-break-glass",
        }, clear=False)

    def test_full_mode_refuses_without_exact_confirmation(self):
        with self.full_environment():
            os.environ.pop("COC_L3_FULL_CONFIRM", None)
            with mock.patch.object(l3_lockout, "monitor_account", return_value="coc-monitor"):
                with self.assertRaises(l3_lockout.FullLockoutRefused):
                    l3_lockout._require_full_mode()

    def test_full_mode_refuses_without_break_glass_account(self):
        with self.full_environment():
            with mock.patch.object(l3_lockout, "monitor_account", return_value="coc-monitor"):
                with mock.patch("l3_lockout.pwd.getpwnam", side_effect=KeyError("missing")):
                    with self.assertRaisesRegex(l3_lockout.FullLockoutRefused, "break-glass account"):
                        l3_lockout._require_full_mode()

    def test_full_site_down_command_rejects_power_control(self):
        with self.full_environment():
            with mock.patch.dict(os.environ, {"COC_SITE_DOWN_CMD": "systemctl reboot"}, clear=False):
                with mock.patch.object(l3_lockout, "_require_full_mode"):
                    with mock.patch.object(l3_lockout, "_capture_evidence", return_value={}):
                        with mock.patch.object(l3_lockout, "_seal_evidence_directory"):
                            with mock.patch.object(l3_lockout, "_full_interactive_users", return_value=[]):
                                with mock.patch.object(l3_lockout, "_account_state", return_value=None):
                                    with self.assertRaisesRegex(
                                        l3_lockout.FullLockoutRefused, "power-control command"
                                    ):
                                        l3_lockout.full_lock("test", now=1792000002)

    def test_full_lock_keeps_break_glass_and_monitor_accounts_out(self):
        with self.full_environment():
            with mock.patch.object(l3_lockout, "_require_full_mode"):
                with mock.patch.object(
                    l3_lockout, "_full_interactive_users",
                    return_value=["root", "alice", "coc-break-glass", "coc-monitor"],
                ):
                    with mock.patch.object(
                        l3_lockout, "_account_state",
                        side_effect=lambda name: {
                            "name": name, "password_status": "P", "expire_days": ""
                        },
                    ) as account_state:
                        with mock.patch("l3_lockout.pwd.getpwnam", side_effect=lambda name: fake_pwent(
                            name, {"root": 0, "alice": 1500, "coc-break-glass": 1501, "coc-monitor": 1502}[name]
                        )):
                            with mock.patch.object(l3_lockout, "_capture_evidence", return_value={"bank_log_hashes": []}):
                                with mock.patch.object(l3_lockout, "_seal_evidence_directory", return_value=True):
                                    with mock.patch.object(l3_lockout, "end_sessions", return_value=[]) as end:
                                        with mock.patch.object(
                                            l3_lockout, "run",
                                            return_value={"cmd": "", "ran": True, "rc": 0, "out": ""},
                                        ) as run:
                                            event, record = l3_lockout.full_lock("test", now=1792000000)
        self.assertEqual(set(record["locked"]), {"root", "alice"})
        self.assertEqual(account_state.call_args_list, [mock.call("root"), mock.call("alice")])
        end.assert_called_once_with([0, 1500], dry_run=False)
        commands = [call.args[0] for call in run.call_args_list]
        compose = os.environ.get(
            "COC_BANK_COMPOSE",
            os.path.join(os.environ.get("APP_DIR", "/opt/chain-of-custody/banking-system"), "docker-compose.yml"),
        )
        site_command = ["docker", "compose", "-f", compose, "stop", "frontend"]
        self.assertIn(site_command, commands, repr(commands))
        self.assertLess(commands.index(site_command), commands.index(["touch", "/etc/nologin"]))
        self.assertIn(["passwd", "-l", "root"], commands)
        self.assertNotIn(["passwd", "-l", "coc-break-glass"], commands)
        self.assertNotIn(["passwd", "-l", "coc-monitor"], commands)
        self.assertTrue(event["detail"]["break_glass_available"])

    def test_full_lock_persists_recovery_and_reports_failed_site_shutdown(self):
        with self.full_environment():
            with mock.patch.object(l3_lockout, "_require_full_mode"):
                with mock.patch.object(l3_lockout, "_full_interactive_users", return_value=[]):
                    with mock.patch.object(l3_lockout, "_capture_evidence", return_value={}):
                        with mock.patch.object(l3_lockout, "_seal_evidence_directory"):
                            with mock.patch.object(l3_lockout, "end_sessions", return_value=[]):
                                with mock.patch.object(
                                    l3_lockout,
                                    "run",
                                    side_effect=lambda command: {
                                        "cmd": command,
                                        "ran": True,
                                        "rc": 1 if command[0] == "docker" else 0,
                                        "out": "",
                                        "error": "site unavailable" if command[0] == "docker" else "",
                                    },
                                ):
                                    event, record = l3_lockout.full_lock("test", now=1792000003)
        self.assertEqual(record["action_state"], "partial")
        self.assertEqual(record["failed_actions"], ["site_down"])
        self.assertEqual(event["detail"]["action_state"], "partial")
        self.assertTrue(os.path.exists(os.path.join(
            self.state_dir, "active-full-lockout.json"
        )))

    def test_full_unlock_restores_saved_states_without_rescanning_accounts(self):
        keys = ["first-key", "second-key", "third-key"]
        hashes = {
            name: hashlib.sha256(key.encode("utf-8")).hexdigest()
            for name, key in zip(("SOC lead", "Auditor", "Compliance officer"), keys)
        }
        with open(self.hashes_path, "w", encoding="utf-8") as handle:
            json.dump(hashes, handle)
        evidence_dir = os.path.join(self.state_dir, "qf-existing")
        os.makedirs(evidence_dir)
        state_path = os.path.join(evidence_dir, "state.json")
        original_users = [
            {"name": "root", "password_status": "P", "expire_days": ""},
            {"name": "alice", "password_status": "L", "expire_days": "20000"},
            {"name": "guest", "password_status": "NP", "expire_days": "-1"},
        ]
        with open(state_path, "w", encoding="utf-8") as handle:
            json.dump({"id": "qf-existing", "action": "lock", "dry_run": False,
                       "users": original_users}, handle)
        pointer = os.path.join(self.state_dir, "active-full-lockout.json")
        with open(pointer, "w", encoding="utf-8") as handle:
            json.dump({"state_file": state_path}, handle)

        with mock.patch.object(l3_lockout, "_full_interactive_users", side_effect=AssertionError("must use saved state")):
            with mock.patch.object(
                l3_lockout, "run",
                return_value={"cmd": "", "ran": True, "rc": 0, "out": ""},
            ) as run:
                event, ok = l3_lockout.full_unlock(keys[:2], now=1792000001)

        self.assertTrue(ok)
        self.assertEqual(event["trigger"], "quarantine:released")
        commands = [call.args[0] for call in run.call_args_list]
        self.assertIn(["rm", "-f", "/etc/nologin"], commands)
        self.assertIn(["passwd", "-u", "root"], commands)
        self.assertNotIn(["passwd", "-u", "alice"], commands)
        self.assertIn(["passwd", "-d", "guest"], commands)
        self.assertIn(["usermod", "--expiredate", "", "root"], commands)
        from datetime import datetime, timedelta
        expected_alice_expiry = (datetime(1970, 1, 1) + timedelta(days=20000)).date().isoformat()
        self.assertIn(["usermod", "--expiredate", expected_alice_expiry, "alice"], commands)
        with open(state_path, encoding="utf-8") as handle:
            restored_state = json.load(handle)
        self.assertEqual(restored_state["users"], original_users)
        self.assertFalse(os.path.exists(pointer))

    def test_failed_full_unlock_keeps_recovery_pointer_and_reports_partial(self):
        keys = ["first-key", "second-key", "third-key"]
        hashes = {
            name: hashlib.sha256(key.encode("utf-8")).hexdigest()
            for name, key in zip(("SOC lead", "Auditor", "Compliance officer"), keys)
        }
        with open(self.hashes_path, "w", encoding="utf-8") as handle:
            json.dump(hashes, handle)
        evidence_dir = os.path.join(self.state_dir, "qf-retry")
        os.makedirs(evidence_dir)
        state_path = os.path.join(evidence_dir, "state.json")
        with open(state_path, "w", encoding="utf-8") as handle:
            json.dump({"id": "qf-retry", "action": "lock", "dry_run": False, "users": []}, handle)
        pointer = os.path.join(self.state_dir, "active-full-lockout.json")
        with open(pointer, "w", encoding="utf-8") as handle:
            json.dump({"state_file": state_path}, handle)

        with mock.patch.object(
            l3_lockout,
            "run",
            return_value={"cmd": [], "ran": True, "rc": 1, "out": "", "error": "permission denied"},
        ):
            event, ok = l3_lockout.full_unlock(keys[:2], now=1792000004)

        self.assertFalse(ok)
        self.assertEqual(event["state"], "alert")
        self.assertEqual(event["detail"]["action_state"], "partial_restore")
        self.assertTrue(os.path.exists(pointer))

    def test_generated_full_keys_are_private_and_stdout_contains_hashes_only(self):
        keys_path = os.path.join(self.state_dir, "full-keys.txt")
        with self.full_environment():
            output = io.StringIO()
            with redirect_stdout(output), mock.patch.object(sys, "argv", ["l3_lockout.py", "keys", keys_path]):
                l3_lockout.main()
        with open(keys_path, encoding="utf-8") as handle:
            private_keys = handle.read()
        stdout = output.getvalue()
        if os.name == "posix":
            self.assertEqual(stat.S_IMODE(os.stat(keys_path).st_mode), 0o600)
        self.assertTrue(os.path.exists(self.hashes_path))
        for line in private_keys.splitlines():
            key = line.split(": ", 1)[1]
            digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
            self.assertNotIn(key, stdout)
            self.assertIn(digest, stdout)
        self.assertNotIn("\n", stdout.strip().split("sha256:")[-1])

    def test_full_lockout_code_path_contains_no_power_control_command(self):
        layer3 = os.path.dirname(os.path.abspath(__file__))
        sources = (
            os.path.join(layer3, "l3_lockout.py"),
            os.path.join(layer3, "..", "layer1", "monitor.py"),
            os.path.join(layer3, "lockout.sh"),
            os.path.join(layer3, "full-lockout.sh"),
        )
        forbidden = re.compile(
            r"""(?i)(?:subprocess\.run|run)\s*\(\s*\[\s*['"](?:reboot|shutdown|poweroff|halt)['"]"""
        )
        for path in sources:
            with open(path, encoding="utf-8") as handle:
                self.assertIsNone(forbidden.search(handle.read()), path)


if __name__ == "__main__":
    unittest.main()
