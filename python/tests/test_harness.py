"""Tests for the differential harness and its reporting helpers."""

from __future__ import annotations

import sqlite3
import unittest

from planproof.harness import canonical, compare, generate_queries, q_error_stats, reorder_count


class CanonicalTests(unittest.TestCase):
    def test_floats_are_rounded_and_rows_sorted(self) -> None:
        left = [[1, 0.30000000000000004], [2, 0.5]]
        right = [[2, 0.5], [1, 0.3]]
        self.assertEqual(canonical(left), canonical(right))

    def test_integers_and_floats_compare_equal(self) -> None:
        self.assertEqual(canonical([[1, 2]]), canonical([[1, 2.0]]))


class CompareTests(unittest.TestCase):
    def setUp(self) -> None:
        self.connection = sqlite3.connect(":memory:")
        self.connection.execute("CREATE TABLE t (a INTEGER, b REAL)")
        self.connection.executemany("INSERT INTO t VALUES (?, ?)", [(1, 1.5), (2, 2.5)])
        self.queries = [{"id": "q1", "kind": "filter+limit", "sql": "SELECT a, b FROM t ORDER BY a"}]

    def test_matching_rows_pass(self) -> None:
        engine = {"q1": {"rows": [[1, 1.5], [2, 2.5]], "ms": 1.0, "plan": {}}}
        outcomes = compare(self.queries, engine, self.connection)
        self.assertTrue(outcomes[0]["ok"])

    def test_wrong_rows_fail(self) -> None:
        engine = {"q1": {"rows": [[1, 1.5]], "ms": 1.0, "plan": {}}}
        outcomes = compare(self.queries, engine, self.connection)
        self.assertFalse(outcomes[0]["ok"])
        self.assertEqual(outcomes[0]["error"], "row mismatch")

    def test_engine_error_is_reported(self) -> None:
        engine = {"q1": {"error": "unknown table"}}
        outcomes = compare(self.queries, engine, self.connection)
        self.assertFalse(outcomes[0]["ok"])
        self.assertEqual(outcomes[0]["error"], "unknown table")


class PlannerMetricTests(unittest.TestCase):
    def test_q_error_uses_final_stage(self) -> None:
        engine = {
            "q1": {"stages": [10, 100], "plan": {"estimated_rows": 50}},
            "q2": {"stages": [5], "plan": {"estimated_rows": 20}},
        }
        kinds = {"q1": "three-table join", "q2": "join+group"}
        stats = q_error_stats(engine, kinds)
        self.assertEqual(stats["count"], 2)
        self.assertAlmostEqual(stats["max"], 4.0)

    def test_reorder_count_ignores_non_join_queries(self) -> None:
        cost = {"q1": {"plan": {"order": ["b", "a"]}}, "q2": {"plan": {"order": ["t"]}}}
        naive = {"q1": {"plan": {"order": ["a", "b"]}}, "q2": {"plan": {"order": ["t"]}}}
        kinds = {"q1": "join+group", "q2": "distinct"}
        self.assertEqual(reorder_count(cost, naive, kinds), (1, 1))


class GeneratorTests(unittest.TestCase):
    def test_query_kinds_are_balanced(self) -> None:
        queries = generate_queries(16, seed=1)
        self.assertEqual(len(queries), 16)
        kinds = {entry["kind"] for entry in queries}
        self.assertIn("join+group", kinds)
        self.assertIn("three-table join", kinds)
        self.assertIn("distinct", kinds)


if __name__ == "__main__":
    unittest.main()
