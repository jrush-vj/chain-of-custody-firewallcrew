"""Tests for the real, scoped Layer 3 lockout. The safety-guard tests are the ones that matter most:
no input, environment variable, or trigger condition may ever make this touch root or the account
running it. Run: python -m unittest -v test_l3_lockout.py
"""

import os
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
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


if __name__ == "__main__":
    unittest.main()
