"""Tests for the FULL (root-capable) lockout module. Run: python -m unittest -v test_l3_full_lockout.py

This module is destructive by design, so the tests that matter most here prove: (1) it never runs a
real command unless dry_run is explicitly False, (2) a reboot/shutdown-style configured command is
refused before anything else runs, (3) the multi-user session-ending logic still excludes this
process and its ancestors, and (4) root is only included when actually configured (via "auto"
discovery matching /etc/passwd, or an explicit list) — never implicitly.
"""

import os
import sys
import tempfile
import types
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

_dir = tempfile.mkdtemp(prefix="coc-l3-full-test-")
os.environ["COC_L3_STATE"] = _dir

import l3_full_lockout as full  # noqa: E402


def fake_pwent(uid):
    return types.SimpleNamespace(pw_uid=uid)


class ConfiguredUsersTests(unittest.TestCase):
    def setUp(self):
        self.saved_env = dict(os.environ)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self.saved_env)

    def test_auto_discovers_root_plus_normal_shelled_accounts_from_passwd(self):
        passwd = os.path.join(_dir, "passwd")
        with open(passwd, "w", encoding="utf-8") as handle:
            handle.write(
                "root:x:0:0:root:/root:/bin/bash\n"
                "daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin\n"
                "nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\n"
                "alice:x:1500:1500:Alice:/home/alice:/bin/bash\n"
                "coc-demo-intruder:x:1501:1501:demo:/home/coc-demo-intruder:/bin/bash\n"
                "backup:x:34:34:backup:/var/backups:/bin/false\n"
            )
        users = full.interactive_users(passwd)
        self.assertEqual(sorted(users), sorted(["root", "alice", "coc-demo-intruder"]))
        self.assertNotIn("daemon", users)
        self.assertNotIn("nobody", users)
        self.assertNotIn("backup", users)

    def test_root_is_only_included_when_configured_auto_or_explicit(self):
        os.environ["COC_L3_FULL_USERS"] = "alice,bob"
        self.assertEqual(full.configured_users(), ["alice", "bob"])
        self.assertNotIn("root", full.configured_users())

        os.environ["COC_L3_FULL_USERS"] = "root,alice"
        self.assertIn("root", full.configured_users())

    def test_no_passwd_file_falls_back_to_root_only_not_silently_empty(self):
        self.assertEqual(full.interactive_users("/no/such/file"), ["root"])


class SafetyRefusalTests(unittest.TestCase):
    def setUp(self):
        self.saved = dict(os.environ)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self.saved)

    def test_a_reboot_style_site_down_command_is_refused_before_anything_runs(self):
        os.environ["COC_L3_SITE_DOWN"] = "systemctl reboot"
        with mock.patch("l3_full_lockout.touch_nologin") as nologin, mock.patch("l3_full_lockout.lock_user") as lock_user:
            with self.assertRaises(full.ConfiguredBadly):
                full.lock("test", dry_run=True, users=["root"])
            nologin.assert_not_called()
            lock_user.assert_not_called()

    def test_a_shutdown_style_site_up_command_is_also_refused(self):
        os.environ["COC_L3_SITE_UP"] = "shutdown -h now"
        with self.assertRaises(full.ConfiguredBadly):
            full.lock("test", dry_run=True, users=["root"])

    def test_dry_run_true_runs_no_subprocess_at_all(self):
        with mock.patch("l3_full_lockout.subprocess.run") as run:
            event, record = full.lock("test", dry_run=True, users=["root", "alice"], now=1792000000)
            run.assert_not_called()
        self.assertTrue(record["dry_run"])
        self.assertTrue(all(not step["ran"] for step in record["site_down"]))
        self.assertTrue(all(not step["ran"] for pair in record["locked"].values() for step in pair))

    def test_dry_run_false_does_run_the_real_commands(self):
        with mock.patch("l3_full_lockout.subprocess.run", return_value=types.SimpleNamespace(returncode=0, stdout="", stderr="")) as run:
            with mock.patch("l3_full_lockout.os.kill"):
                event, record = full.lock("test", dry_run=False, users=["root"], now=1792000001)
        self.assertFalse(record["dry_run"])
        self.assertTrue(run.called)
        # the exact commands demanded: touch /etc/nologin, passwd -l, usermod --expiredate 1
        called_commands = [call.args[0] for call in run.call_args_list]
        self.assertIn(["touch", "/etc/nologin"], called_commands)
        self.assertIn(["passwd", "-l", "root"], called_commands)
        self.assertIn(["usermod", "--expiredate", "1", "root"], called_commands)

    def test_unlock_runs_passwd_unlock_and_clears_expiry(self):
        with mock.patch("l3_full_lockout.subprocess.run", return_value=types.SimpleNamespace(returncode=0, stdout="", stderr="")) as run:
            with mock.patch("l3_full_lockout.os.path.exists", return_value=False):
                event, record = full.unlock(dry_run=False, users=["root"], now=1792000002)
        called_commands = [call.args[0] for call in run.call_args_list]
        self.assertIn(["passwd", "-u", "root"], called_commands)
        self.assertIn(["usermod", "--expiredate", "", "root"], called_commands)


class SessionEndingTests(unittest.TestCase):
    """Proc-scanning generalized to multiple uids: still excludes this process and its ancestors."""

    def make_proc(self, procs):
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

    def test_finds_sessions_across_several_uids_including_root(self):
        procs = {
            100: (1, 0, 4, None),      # root, has a tty: a session
            200: (1, 1500, 5, None),   # a normal user, has a tty: a session
            300: (1, 1501, 0, None),   # a different normal user, no tty, no auid: not a session
        }
        with mock.patch("l3_full_lockout.os.getpid", return_value=999999):
            root = self.make_proc(procs)
            found = full.login_sessions_of([0, 1500, 1501], proc_root=root)
        self.assertEqual(sorted(item["pid"] for item in found), [100, 200])

    def test_never_includes_this_process_or_its_ancestors_even_when_root_is_in_scope(self):
        procs = {
            50: (1, 0, 3, None),    # root, ancestor of this script
            60: (50, 0, 0, None),   # this script's own pid, running as root
            70: (1, 0, 7, None),    # an unrelated root session: must still be found
        }
        root = self.make_proc(procs)
        with mock.patch("l3_full_lockout.os.getpid", return_value=60):
            found = full.login_sessions_of([0], proc_root=root)
        pids = [item["pid"] for item in found]
        self.assertNotIn(50, pids)
        self.assertNotIn(60, pids)
        self.assertIn(70, pids)

    def test_end_sessions_in_dry_run_kills_nothing(self):
        with mock.patch("l3_full_lockout.login_sessions_of", return_value=[{"pid": 111, "cmd": "bash"}]):
            with mock.patch("l3_full_lockout.os.kill") as kill:
                result = full.end_sessions(["root"], dry_run=True)
        kill.assert_not_called()
        self.assertTrue(result[0]["dry_run"])
        self.assertFalse(result[0]["killed"])


class CliGateTests(unittest.TestCase):
    """The CLI itself: --real is the only way to get dry_run=False, and it must not be the default."""

    def test_without_real_flag_main_uses_dry_run(self):
        with mock.patch("l3_full_lockout.lock", return_value=({}, {})) as lock_fn:
            with mock.patch.object(sys, "argv", ["l3_full_lockout.py", "lock", "reason"]):
                full.main()
            self.assertEqual(lock_fn.call_args.kwargs.get("dry_run", lock_fn.call_args.args[1] if len(lock_fn.call_args.args) > 1 else None), True)

    def test_with_real_flag_main_uses_real(self):
        with mock.patch("l3_full_lockout.lock", return_value=({}, {})) as lock_fn:
            with mock.patch.object(sys, "argv", ["l3_full_lockout.py", "lock", "--real", "reason"]):
                full.main()
            args, kwargs = lock_fn.call_args
            dry_run_value = kwargs.get("dry_run", args[1] if len(args) > 1 else None)
            self.assertEqual(dry_run_value, False)


if __name__ == "__main__":
    unittest.main()
