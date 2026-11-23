"""Differential harness: generate data and queries, then compare planproof to SQLite.

SQLite is the oracle. A query passes only when the engine's rows, treated as a
multiset, match SQLite's rows exactly after rounding floats. That is a stronger
claim than "the engine returns something", and it is the reason the SQL subset is
small enough to be exhaustive.
"""

from __future__ import annotations

import csv
import json
import random
import sqlite3
import subprocess
import time
from pathlib import Path
from typing import Any

REGIONS = ["east", "west", "north", "south"]
CHANNELS = ["web", "app", "store", "partner"]
TIERS = [1, 2, 3, 4]
PRODUCTS = [f"p{index:03d}" for index in range(120)]

SCHEMA = {
    "customers": ["id", "name", "region", "tier"],
    "orders": ["id", "customer_id", "amount", "qty", "channel"],
    "items": ["id", "order_id", "product", "price", "qty"],
}


def build_data(directory: Path, seed: int, orders: int = 60_000) -> dict[str, int]:
    """Write three related CSV tables and return their row counts."""
    rng = random.Random(seed)
    directory.mkdir(parents=True, exist_ok=True)
    customers = 2_000
    items = orders * 3

    with (directory / "customers.csv").open("w", encoding="utf-8", newline="\n") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(SCHEMA["customers"])
        for index in range(customers):
            writer.writerow([index, f"customer{index}", rng.choice(REGIONS), rng.choice(TIERS)])

    with (directory / "orders.csv").open("w", encoding="utf-8", newline="\n") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(SCHEMA["orders"])
        for index in range(orders):
            # 5% of channels are missing on purpose: NULL handling is part of the
            # contract and the differential test should cover it.
            channel = "" if rng.random() < 0.05 else rng.choice(CHANNELS)
            writer.writerow(
                [
                    index,
                    rng.randrange(customers),
                    round(rng.uniform(5, 900), 2),
                    rng.randint(1, 9),
                    channel,
                ]
            )

    with (directory / "items.csv").open("w", encoding="utf-8", newline="\n") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(SCHEMA["items"])
        for index in range(items):
            writer.writerow(
                [
                    index,
                    rng.randrange(orders),
                    rng.choice(PRODUCTS),
                    round(rng.uniform(1, 120), 2),
                    rng.randint(1, 5),
                ]
            )
    return {"customers": customers, "orders": orders, "items": items}


def open_sqlite(directory: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(":memory:")
    connection.execute("CREATE TABLE customers (id INTEGER, name TEXT, region TEXT, tier INTEGER)")
    connection.execute(
        "CREATE TABLE orders (id INTEGER, customer_id INTEGER, amount REAL, qty INTEGER, channel TEXT)"
    )
    connection.execute(
        "CREATE TABLE items (id INTEGER, order_id INTEGER, product TEXT, price REAL, qty INTEGER)"
    )
    for name, types in (
        ("customers", "?,?,?,?"),
        ("orders", "?,?,?,?,?"),
        ("items", "?,?,?,?,?"),
    ):
        with (directory / f"{name}.csv").open(encoding="utf-8") as handle:
            reader = csv.reader(handle)
            next(reader)
            rows = [[None if value == "" else value for value in row] for row in reader]
        connection.executemany(f"INSERT INTO {name} VALUES ({types})", rows)
    return connection


def generate_queries(count: int, seed: int) -> list[dict[str, str]]:
    rng = random.Random(seed)
    queries: list[dict[str, str]] = []
    for index in range(count):
        kind = index % 8
        if kind == 0:
            sql = (
                f"SELECT id, amount, qty FROM orders WHERE amount > {rng.uniform(50, 700):.2f} "
                f"AND qty <= {rng.randint(3, 9)} ORDER BY amount DESC LIMIT {rng.randint(5, 40)}"
            )
            label = "filter+limit"
        elif kind == 1:
            sql = (
                f"SELECT c.region, COUNT(*) AS n, SUM(o.amount) AS total "
                f"FROM orders o JOIN customers c ON o.customer_id = c.id "
                f"WHERE o.amount > {rng.uniform(10, 400):.2f} "
                f"GROUP BY c.region ORDER BY total DESC"
            )
            label = "join+group"
        elif kind == 2:
            sql = (
                f"SELECT c.region, i.product, SUM(i.price * i.qty) AS revenue "
                f"FROM items i JOIN orders o ON i.order_id = o.id "
                f"JOIN customers c ON o.customer_id = c.id "
                f"WHERE i.price > {rng.uniform(5, 60):.2f} "
                f"GROUP BY c.region, i.product ORDER BY revenue DESC LIMIT {rng.randint(5, 20)}"
            )
            label = "three-table join"
        elif kind == 3:
            sql = (
                f"SELECT c.tier, COUNT(*) AS n FROM items i "
                f"JOIN orders o ON i.order_id = o.id "
                f"JOIN customers c ON o.customer_id = c.id "
                f"WHERE o.qty >= {rng.randint(1, 5)} AND i.qty >= {rng.randint(1, 3)} "
                f"GROUP BY c.tier HAVING n > {rng.randint(1000, 6000)} ORDER BY n DESC"
            )
            label = "having"
        elif kind == 4:
            sql = "SELECT DISTINCT channel FROM orders ORDER BY channel"
            label = "distinct"
        elif kind == 5:
            sql = (
                "SELECT COUNT(*) AS n, AVG(amount) AS avg_amount, MIN(amount) AS lo, "
                "MAX(amount) AS hi FROM orders"
            )
            label = "aggregate"
        elif kind == 6:
            sql = (
                f"SELECT id, amount FROM orders WHERE channel IN ('web', 'app') "
                f"AND qty IN ({rng.randint(1, 3)}, {rng.randint(4, 6)}) "
                f"ORDER BY id LIMIT {rng.randint(10, 50)}"
            )
            label = "in-list"
        else:
            sql = (
                f"SELECT id, amount * qty AS gross FROM orders "
                f"WHERE amount * qty > {rng.uniform(500, 5000):.2f} "
                f"ORDER BY gross DESC LIMIT {rng.randint(5, 25)}"
            )
            label = "arithmetic"
        queries.append({"id": f"q{index:04d}", "kind": label, "sql": sql})
    return queries


def run_engine(
    root: Path, db: Path, queries: list[dict[str, str]], planner: str
) -> dict[str, dict[str, Any]]:
    workdir = root / ".probe"
    workdir.mkdir(exist_ok=True)
    query_file = workdir / f"queries-{planner}.jsonl"
    query_file.write_text(
        "".join(json.dumps({"id": entry["id"], "sql": entry["sql"]}) + "\n" for entry in queries),
        encoding="utf-8",
    )
    started = time.perf_counter()
    completed = subprocess.run(
        [
            "node",
            "--experimental-strip-types",
            str(root / "src" / "main.ts"),
            "--db",
            str(db),
            "--file",
            str(query_file),
            "--planner",
            planner,
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        cwd=root,
    )
    elapsed = time.perf_counter() - started
    results: dict[str, dict[str, Any]] = {}
    for line in completed.stdout.splitlines():
        if not line.strip():
            continue
        payload = json.loads(line)
        payload["_wall_s"] = elapsed
        results[payload["id"]] = payload
    if not results:
        raise RuntimeError(f"engine produced no output: {completed.stderr[-400:]}")
    return results


def canonical(rows: list[list[Any]]) -> list[tuple[Any, ...]]:
    normalized = []
    for row in rows:
        normalized.append(tuple(round(value, 4) if isinstance(value, float) else value for value in row))
    return sorted(normalized, key=repr)


def compare(
    queries: list[dict[str, str]], engine: dict[str, dict[str, Any]], connection: sqlite3.Connection
) -> list[dict[str, Any]]:
    outcomes: list[dict[str, Any]] = []
    for entry in queries:
        result = engine.get(entry["id"], {})
        if "error" in result:
            outcomes.append({"id": entry["id"], "kind": entry["kind"], "ok": False, "error": result["error"]})
            continue
        expected = connection.execute(entry["sql"]).fetchall()
        actual = result.get("rows", [])
        matches = canonical(expected) == canonical(actual)
        outcomes.append(
            {
                "id": entry["id"],
                "kind": entry["kind"],
                "ok": matches,
                "ms": result.get("ms"),
                "scanned": result.get("scanned"),
                "plan": result.get("plan"),
                "expected_rows": len(expected),
                "actual_rows": len(actual),
                "error": None if matches else "row mismatch",
            }
        )
    return outcomes


def q_error_stats(engine: dict[str, dict[str, Any]], kinds: dict[str, str]) -> dict[str, float]:
    """Q-error of the final cardinality estimate for every join query."""
    errors: list[float] = []
    for query_id, kind in kinds.items():
        if kind not in ("join+group", "three-table join", "having"):
            continue
        row = engine.get(query_id, {})
        stages = row.get("stages") or []
        if not stages:
            continue
        estimated = float(row.get("plan", {}).get("estimated_rows") or 1)
        actual = float(stages[-1] or 1)
        errors.append(max(estimated, actual) / max(1.0, min(estimated, actual)))
    if not errors:
        return {"median": 0.0, "p90": 0.0, "max": 0.0, "count": 0}
    errors.sort()
    return {
        "median": round(errors[len(errors) // 2], 3),
        "p90": round(errors[int(len(errors) * 0.9)], 3),
        "max": round(errors[-1], 3),
        "count": len(errors),
    }


def reorder_count(
    cost: dict[str, dict[str, Any]], naive: dict[str, dict[str, Any]], kinds: dict[str, str]
) -> tuple[int, int]:
    """How often the cost planner changed the written order, and on how many queries."""
    changed = 0
    total = 0
    for query_id, kind in kinds.items():
        if kind not in ("join+group", "three-table join", "having"):
            continue
        total += 1
        left = tuple(cost.get(query_id, {}).get("plan", {}).get("order", []))
        right = tuple(naive.get(query_id, {}).get("plan", {}).get("order", []))
        if left != right:
            changed += 1
    return changed, total


def intermediate_rows(engine: dict[str, dict[str, Any]], kinds: dict[str, str]) -> int:
    """Total rows produced by join stages. Deterministic, unlike wall time."""
    total = 0
    for query_id, kind in kinds.items():
        if kind not in ("join+group", "three-table join", "having"):
            continue
        total += sum(engine.get(query_id, {}).get("stages") or [])
    return total
