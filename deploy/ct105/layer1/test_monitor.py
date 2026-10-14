"""Unit tests for the Layer 1 auditd parser. Run: python -m unittest -v test_monitor.py"""

import os
import tempfile
import unittest

_dir = tempfile.mkdtemp(prefix="coc-l1-test-")
os.environ.update({
    "WATCH_DIR": "/var/log/bank-demo",
    "STATE_DIR": _dir,
    "AUDIT_LOG": os.path.join(_dir, "audit.log"),
})
import monitor  # noqa: E402  (environment must be set before import)


def audit_event(serial, command_args, cwd="/root", key="coc_l1", auid="1000"):
    """Lines in the same shape auditd writes for one watched execve."""
    argc = len(command_args)
    args = " ".join(f'a{index}="{arg}"' for index, arg in enumerate(command_args))
    return [
        f'type=SYSCALL msg=audit(1791993837.123:{serial}): arch=c000003e syscall=59 success=yes exit=0 '
        f'a0=55d1 a1=55d2 a2=55d3 a3=0 items=2 ppid=4000 pid=4321 auid={auid} uid=0 gid=0 euid=0 suid=0 '
        f'fsuid=0 egid=0 sgid=0 fsgid=0 tty=pts0 ses=3 comm="{command_args[0]}" '
        f'exe="/usr/bin/{command_args[0]}" key="{key}"',
        f"type=EXECVE msg=audit(1791993837.123:{serial}): argc={argc} {args}",
        f'type=CWD msg=audit(1791993837.123:{serial}): cwd="{cwd}"',
        f'type=PATH msg=audit(1791993837.123:{serial}): item=0 name="/var/log/bank-demo/app.log" inode=1',
    ]


def write_log(lines):
    with open(os.environ["AUDIT_LOG"], "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")


class ParserTests(unittest.TestCase):
    def setUp(self):
        monitor.user_name = lambda uid: f"user{uid}"
        self.state = {"offset": 0, "groups": {}}

    def test_watched_command_becomes_alert_with_who_and_command(self):
        write_log(audit_event(4501, ["sed", "-i", "s/txn 2 ok/txn 2 ok (edited)/", "/var/log/bank-demo/app.log"]))
        events = monitor.read_new_audit_events(self.state)
        self.assertEqual(len(events), 1)
        event = events[0]
        self.assertEqual(event["layer"], 1)
        self.assertEqual(event["trigger"], "command_executed")
        self.assertEqual(event["state"], "alert")
        self.assertEqual(event["detail"]["cmd"], "sed -i s/txn 2 ok/txn 2 ok (edited)/ /var/log/bank-demo/app.log")
        self.assertEqual(event["detail"]["cwd"], "/root")
        self.assertEqual(event["who"]["user"], "user1000")
        self.assertEqual(event["who"]["auid"], "1000")
        self.assertIn("ran on the bank log", event["summary"])

    def test_command_not_on_the_bank_log_path_is_ignored(self):
        write_log(audit_event(4502, ["rm", "/tmp/unrelated.txt"]))
        self.assertEqual(monitor.read_new_audit_events(self.state), [])

    def test_record_without_our_key_is_ignored(self):
        write_log(audit_event(4503, ["rm", "/var/log/bank-demo/app.log"], key="other"))
        self.assertEqual(monitor.read_new_audit_events(self.state), [])

    def test_hex_encoded_argument_is_decoded(self):
        hex_path = "/var/log/bank-demo/app.log".encode().hex().upper()
        lines = [
            'type=SYSCALL msg=audit(1791993838.001:4504): syscall=59 success=yes exit=0 auid=1000 uid=0 '
            'tty=pts1 pid=4400 exe="/usr/bin/truncate" key="coc_l1"',
            f"type=EXECVE msg=audit(1791993838.001:4504): argc=3 a0=\"truncate\" a1=\"-s\" a2={hex_path}",
        ]
        write_log(lines)
        events = monitor.read_new_audit_events(self.state)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["detail"]["cmd"], "truncate -s /var/log/bank-demo/app.log")

    def test_offset_prevents_replaying_old_records(self):
        write_log(audit_event(4505, ["rm", "/var/log/bank-demo/app.log"]))
        first = monitor.read_new_audit_events(self.state)
        second = monitor.read_new_audit_events(self.state)
        self.assertEqual(len(first), 1)
        self.assertEqual(second, [])


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


if __name__ == "__main__":
    unittest.main()
