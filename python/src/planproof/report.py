"""Report for a planproof run."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def write_report(result: dict[str, Any], out_dir: Path) -> dict[str, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    metrics_path = out_dir / "metrics.json"
    metrics_path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")

    lines = [
        "# planproof report",
        "",
        f"- tables: {result['rows']['customers']:,} customers, "
        f"{result['rows']['orders']:,} orders, {result['rows']['items']:,} items",
        f"- queries: {result['queries']}",
        f"- cost planner: {result['pass_cost']}/{result['queries']} identical to SQLite",
        f"- naive planner: {result['pass_naive']}/{result['queries']} identical to SQLite",
        "",
        "## Estimation quality",
        "",
        "| metric | value |",
        "| --- | --- |",
        f"| join queries | {result['q_error']['count']} |",
        f"| q-error median | {result['q_error']['median']:.2f}x |",
        f"| q-error p90 | {result['q_error']['p90']:.2f}x |",
        f"| q-error max | {result['q_error']['max']:.2f}x |",
        "",
        "## Planning effect",
        "",
        "| metric | value |",
        "| --- | --- |",
        f"| join orders changed vs written order | {result['reorders']}/{result['join_queries']} |",
        f"| intermediate rows, cost planner | {result['cost_rows']:,} |",
        f"| intermediate rows, written order | {result['naive_rows']:,} |",
        f"| reduction | {result['reduction']:.1f}% |",
        "",
        "## Mismatches",
        "",
    ]
    if result["failures"]:
        lines.extend(["| query | kind | problem |", "| --- | --- | --- |"])
        for failure in result["failures"][:10]:
            lines.append(f"| {failure['id']} | {failure['kind']} | {failure['error']} |")
    else:
        lines.append("None. Every generated query produced exactly SQLite's rows.")

    lines.extend(
        [
            "",
            "## Reading the q-error",
            "",
            "A q-error of 2.6 means the planner's final cardinality estimate was "
            "off by a factor of 2.6 at the median. That is normal for a model that "
            "assumes independence between predicates.",
            "",
            "The headline metric is intermediate rows, not wall time. Two timed runs "
            "of the same experiment disagreed by 20 percentage points in both "
            "directions, so a stopwatch cannot separate these plans on this machine. "
            "Row counts can.",
        ]
    )

    report_path = out_dir / "report.md"
    report_path.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    return {"report": report_path, "metrics": metrics_path}
