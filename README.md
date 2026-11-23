# planproof

**中文简介** — 一个用 TypeScript 从零写的 SQL 引擎，带代价模型连接排序。它把 240 条随机生成的查询逐行对照 SQLite，公开通过率、基数估计误差（q-error）和规划收益，而不是只展示一个跑得通的 demo。

**English** — A SQL engine written from scratch in TypeScript with a cost-based join planner. Every generated query is checked row-for-row against SQLite, and the project publishes its estimation error instead of hiding it.

```console
$ python scripts/demo.py
planproof 0.1.0  240 queries  {'customers': 2000, 'orders': 60000, 'items': 180000}
cost planner : 240/240 match SQLite
naive planner: 240/240 match SQLite
q-error median 2.60x  p90 7.36x  reorders 90/90
intermediate rows: cost 11,960,711 vs written 16,065,002 (25.5% fewer)
```

## Why this exists

Writing a SQL engine is easy to fake: handle the queries in your README and stop.
The hard part is agreeing with a real database on NULLs, integer division, float
sums, `ORDER BY` ties, and `GROUP BY` semantics. `planproof` uses SQLite as an
oracle and refuses to claim correctness beyond what 240 randomised queries prove.

The planner is the second half of the experiment. It enumerates connected join
orders (four tables or fewer, so at most 24 permutations), scores each by the sum
of intermediate cardinalities, and reports how far its estimate was from the
actual row count. A planner you cannot calibrate is a random number generator
with extra steps.

## Architecture

| Layer | Language | Responsibility |
| --- | --- | --- |
| engine | TypeScript (Node 22, no build step) | tokeniser, parser, planner, hash-join executor, CSV storage |
| oracle | Python 3.11 (stdlib only) | data generation, query generation, SQLite comparison, reporting |
| queries | SQL | eight query families, from a filtered scan to a three-table aggregate |

## The SQL subset

`SELECT [DISTINCT]` · inner `JOIN ... ON` (up to four tables) · `WHERE` ·
`GROUP BY` · `HAVING` · `ORDER BY` · `LIMIT` · `IN` · `IS [NOT] NULL` ·
arithmetic · `COUNT/SUM/AVG/MIN/MAX`.

Deliberately absent: subqueries, outer joins, window functions, indexes, and
transactions. Each absence keeps the differential test exhaustive rather than
impressive.

## Results

Data: 2,000 customers, 60,000 orders, 180,000 order items. Queries: 240, eight
families, generated from a fixed seed so the run is reproducible.

| Check | Result |
| --- | --- |
| Cost planner vs SQLite | 240/240 identical |
| Written-order planner vs SQLite | 240/240 identical |
| Join queries reordered | 90/90 |
| q-error, median / p90 / max | 2.60× / 7.36× / 9.18× |
| Intermediate rows, cost vs written order | 11,960,711 vs 16,065,002 (25.5% fewer) |

The metric is intermediate rows rather than wall time, on purpose. Two timed runs
of the same experiment disagreed by twenty percentage points in opposite
directions, so a stopwatch cannot separate these plans on one machine. Row counts
can, and they say the planner removes a quarter of the work.

The q-error explains why the gain is not larger: in a star schema with two
thousand customers, almost any order is workable, and predicate independence is
the assumption inflating the estimates.

## Quick start

```bash
python scripts/demo.py
```

Or step by step:

```bash
PYTHONPATH=python/src python -m planproof run --orders 60000 --queries 240 --workdir planproof-run

node --experimental-strip-types src/main.ts --db planproof-run/data \
  --sql "SELECT c.region, COUNT(*) AS n FROM orders o JOIN customers c ON o.customer_id = c.id GROUP BY c.region ORDER BY n DESC"
```

Add `--planner naive` to run the same query with the order as written, and
`--explain` is implicit: every batch result carries the chosen order, the cost,
the number of orders considered, and the intermediate row counts.

Requirements: Node 22.6+ (TypeScript runs through `--experimental-strip-types`,
so there is no build step and no `node_modules`), Python 3.11+ for the harness.

## Limits

- **Row-at-a-time execution.** Vectors, parallelism, and compression are absent,
  which is why 240 queries take half a minute rather than milliseconds.
- **Independence assumption.** Selectivity multiplies across predicates, so
  correlated columns are misestimated; the q-error table is the receipt.
- **No indexes.** Every scan reads the whole CSV; the planner only decides join
  order, not access paths.
- **Four tables.** The permutation search is exhaustive up to 4! = 24 orders and
  refuses larger queries instead of silently switching to a greedy heuristic.

## Repository layout

```
src/sql.ts          tokeniser, AST, recursive-descent parser
src/engine.ts       CSV storage, cost model, hash joins, aggregation
src/main.ts         CLI for one query or a batch
python/src/planproof/harness.py   data, queries, SQLite oracle, q-error
python/src/planproof/report.py    Markdown and metrics
scripts/demo.py     the whole experiment in one command
```

## Development

```bash
PYTHONPATH=python/src python -m unittest discover -s python/tests -t python/tests -v
cd python && pip install -e ".[dev]" && ruff check . && mypy
```

## License

MIT. See [LICENSE](LICENSE).
