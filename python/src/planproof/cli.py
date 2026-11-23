"""Command-line interface for planproof."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import cast

from . import __version__
from .harness import (
    build_data,
    compare,
    generate_queries,
    intermediate_rows,
    open_sqlite,
    q_error_stats,
    reorder_count,
    run_engine,
)
from .report import write_report

EXIT_OK = 0
EXIT_ERROR = 2
ROOT = Path(__file__).resolve().parents[3]


def cmd_run(args: argparse.Namespace) -> int:
    workdir = Path(args.workdir)
    data = workdir / "data"
    rows = build_data(data, seed=args.seed, orders=args.orders)
    connection = open_sqlite(data)
    queries = generate_queries(args.queries, seed=args.seed + 6)
    kinds = {entry["id"]: entry["kind"] for entry in queries}

    cost = run_engine(ROOT, data, queries, "cost")
    naive = run_engine(ROOT, data, queries, "naive")
    cost_outcomes = compare(queries, cost, connection)
    naive_outcomes = compare(queries, naive, connection)

    cost_rows = intermediate_rows(cost, kinds)
    naive_rows = intermediate_rows(naive, kinds)
    changed, total = reorder_count(cost, naive, kinds)

    failures = [
        {"id": row["id"], "kind": row["kind"], "error": row["error"]}
        for row in cost_outcomes
        if not row["ok"]
    ]
    result = {
        "rows": rows,
        "queries": len(queries),
        "pass_cost": sum(1 for row in cost_outcomes if row["ok"]),
        "pass_naive": sum(1 for row in naive_outcomes if row["ok"]),
        "q_error": q_error_stats(cost, kinds),
        "reorders": changed,
        "join_queries": total,
        "cost_rows": cost_rows,
        "naive_rows": naive_rows,
        "reduction": (100 * (1 - cost_rows / naive_rows)) if naive_rows else 0.0,
        "failures": failures,
    }
    paths = write_report(result, workdir / "reports")

    print(f"planproof {__version__}  {len(queries)} queries  {rows}")
    print(f"cost planner : {result['pass_cost']}/{result['queries']} match SQLite")
    print(f"naive planner: {result['pass_naive']}/{result['queries']} match SQLite")
    q_error = cast(dict[str, float], result["q_error"])
    print(f"q-error median {q_error['median']:.2f}x  p90 {q_error['p90']:.2f}x  reorders {changed}/{total}")
    print(
        f"intermediate rows: cost {cost_rows:,} vs written {naive_rows:,} ({result['reduction']:.1f}% fewer)"
    )
    print(f"report: {paths['report']}")
    return EXIT_OK if not failures else EXIT_ERROR


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="planproof",
        description="Run a SQL engine against SQLite on randomised queries and report plan quality.",
    )
    parser.add_argument("--version", action="version", version=f"planproof {__version__}")
    subparsers = parser.add_subparsers(dest="command", required=True)
    run = subparsers.add_parser("run", help="build data, generate queries, and compare to SQLite")
    run.add_argument("--orders", type=int, default=60_000)
    run.add_argument("--queries", type=int, default=240)
    run.add_argument("--seed", type=int, default=11)
    run.add_argument("--workdir", default="planproof-run")
    run.set_defaults(func=cmd_run)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except (ValueError, OSError, RuntimeError) as error:
        print(f"planproof: {error}", file=sys.stderr)
        return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())
