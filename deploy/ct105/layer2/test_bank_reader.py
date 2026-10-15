"""Tests for the bank reader. Run: python -m unittest -v test_bank_reader.py"""

import re
import subprocess
import unittest

import bank_reader as reader

# The same vector is asserted in witness/test/banksync.test.js: both sides must hash the same text.
VECTOR_ROW = {"id": 7, "type": "deposit", "amount": "200.00", "status": "completed",
              "from_account_id": None, "to_account_id": 3, "timestamp": "2026-10-14 15:30:22.123456"}
VECTOR_HASH = "1ffd7af7d32603d1e90e9c67ff7bac22"


def table(count):
    return {i: {"id": i, "type": "deposit", "amount": f"{i * 100}.00", "status": "completed",
                "from_account_id": None, "to_account_id": i, "timestamp": f"2026-10-14 10:00:{i:02d}"}
            for i in range(1, count + 1)}


class FakePsql:
    """Stands in for the database: answers the two query shapes the reader uses, and records them."""

    def __init__(self, rows):
        self.rows = rows
        self.queries = []

    def __call__(self, sql):
        self.queries.append(sql)
        if sql.startswith("SELECT id FROM transactions"):
            return "\n".join(str(i) for i in sorted(self.rows)) + "\n"
        wanted = [int(i) for i in re.search(r"IN \(([0-9,]+)\)", sql).group(1).split(",")]
        lines = []
        for i in sorted(wanted):
            row = self.rows[i]
            lines.append("|".join([str(row["id"]), row["type"], row["amount"], row["status"],
                                   "" if row["from_account_id"] is None else str(row["from_account_id"]),
                                   "" if row["to_account_id"] is None else str(row["to_account_id"]), row["timestamp"]]))
        return "\n".join(lines) + "\n"


class ReaderTests(unittest.TestCase):
    def setUp(self):
        self.saved = reader.psql

    def tearDown(self):
        reader.psql = self.saved

    def test_hash_matches_the_witnesss_vector(self):
        self.assertEqual(reader.canonical(VECTOR_ROW), "7|deposit|200.00|completed||3|2026-10-14 15:30:22.123456")
        self.assertEqual(reader.row_hash(VECTOR_ROW), VECTOR_HASH)

    def test_ranges(self):
        self.assertEqual(reader.to_ranges([1, 2, 3, 5, 6, 9]), "1-3,5-6,9")
        self.assertEqual(reader.to_ranges([]), "")
        self.assertEqual(reader.to_ranges([4]), "4")

    def test_rows_are_parsed_with_null_account_ids(self):
        reader.psql = FakePsql(table(3))
        rows = reader.rows_by_ids([2, 3])
        self.assertEqual([r["id"] for r in rows], [2, 3])
        self.assertIsNone(rows[0]["from_account_id"])
        self.assertEqual(rows[0]["to_account_id"], 2)
        self.assertEqual(rows[0]["amount"], "200.00")

    def test_queries_only_ever_name_the_allowed_columns(self):
        fake = FakePsql(table(5))
        reader.psql = fake
        reader.build_view(0)
        self.assertTrue(fake.queries)
        for sql in fake.queries:
            for forbidden in ("reference", "iban", "account_number", "external", "name", "*"):
                self.assertNotIn(forbidden, sql.lower(), f"{forbidden!r} in {sql}")

    def test_ids_must_be_integers_so_nothing_can_be_injected_into_sql(self):
        fake = FakePsql(table(3))
        reader.psql = fake
        with self.assertRaises(ValueError):
            reader.rows_by_ids(["1); DROP TABLE transactions; --"])
        self.assertEqual(fake.queries, [], "no query may run when an id is not an integer")

    def test_view_summarises_the_bank(self):
        reader.psql = FakePsql(table(8))
        view, position = reader.build_view(0, size=3)
        self.assertEqual((view["count"], view["max_id"], view["ranges"]), (8, 8, "1-8"))
        self.assertEqual([pair[0] for pair in view["sweep"]], [1, 2, 3])
        self.assertEqual(position, 3)
        for _, digest in view["sweep"]:
            self.assertRegex(digest, r"^[0-9a-f]{32}$")

    def test_the_sample_rotates_and_wraps_so_every_row_is_checked_in_turn(self):
        reader.psql = FakePsql(table(7))
        seen, position = set(), 0
        for _ in range(3):
            view, position = reader.build_view(position, size=3)
            seen |= {pair[0] for pair in view["sweep"]}
        self.assertEqual(seen, set(range(1, 8)))

    def test_a_changed_row_changes_its_hash_only(self):
        rows = table(4)
        reader.psql = FakePsql(rows)
        before, _ = reader.build_view(0, size=4)
        rows[2]["status"] = "failed"
        after, _ = reader.build_view(0, size=4)
        changed = [b[0] for b, a in zip(before["sweep"], after["sweep"]) if b[1] != a[1]]
        self.assertEqual(changed, [2])

    def test_an_empty_table_is_a_valid_view(self):
        reader.psql = FakePsql({})
        view, position = reader.build_view(0)
        self.assertEqual(view, {"count": 0, "max_id": 0, "ranges": "", "sweep": []})
        self.assertEqual(position, 0)

    def test_too_many_gaps_is_reported_rather_than_truncated(self):
        reader.psql = FakePsql({i: table(1)[1] | {"id": i} for i in range(1, 2200, 2)})
        with self.assertRaises(reader.BankReadError):
            reader.build_view(0)

    def test_a_missing_docker_is_a_read_error_not_a_crash(self):
        reader.psql = self.saved
        original = subprocess.run

        def broken(*args, **kwargs):
            raise FileNotFoundError("docker")

        subprocess.run = broken
        try:
            with self.assertRaises(reader.BankReadError):
                reader.all_ids()
        finally:
            subprocess.run = original


if __name__ == "__main__":
    unittest.main()
