"""planproof: a small SQL engine verified against SQLite."""

from __future__ import annotations

__version__ = "0.1.0"

from .harness import build_data, compare, generate_queries, open_sqlite, run_engine  # noqa: E402

__all__ = ["__version__", "build_data", "compare", "generate_queries", "open_sqlite", "run_engine"]
