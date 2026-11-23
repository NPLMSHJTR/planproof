#!/usr/bin/env node
/**
 * planproof CLI.
 *
 * Single query:  node --experimental-strip-types src/main.ts --db data --sql "SELECT ..."
 * Batch:         node --experimental-strip-types src/main.ts --db data --file queries.jsonl
 *
 * Batch mode exists so a differential test can send 200 queries through one
 * process and still get a per-query latency.
 */

import { readFileSync } from "node:fs";

import { execute, loadCatalog, plan } from "./engine.ts";
import { parse, SqlError } from "./sql.ts";
import type { Value } from "./sql.ts";

type Options = {
  db: string;
  sql?: string;
  file?: string;
  planner: "cost" | "naive";
  explain: boolean;
};

function parseArgs(argv: string[]): Options {
  const options: Options = { db: "data", planner: "cost", explain: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--db") options.db = argv[++index];
    else if (arg === "--sql") options.sql = argv[++index];
    else if (arg === "--file") options.file = argv[++index];
    else if (arg === "--planner") options.planner = argv[++index] as "cost" | "naive";
    else if (arg === "--explain") options.explain = true;
  }
  return options;
}

function runOne(sql: string, catalog: ReturnType<typeof loadCatalog>, options: Options) {
  const started = process.hrtime.bigint();
  const query = parse(sql);
  const chosen = plan(query, catalog, options.planner);
  const result = execute(query, chosen, catalog);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  return {
    columns: result.columns,
    rows: result.rows as Value[][],
    scanned: result.scanned,
    stages: result.stages,
    ms: Number(ms.toFixed(3)),
    plan: {
      order: chosen.order.map((ref) => ref.alias),
      estimated_rows: chosen.estimatedRows,
      cost: Number(chosen.cost.toFixed(1)),
      considered: chosen.considered,
      mode: chosen.mode,
    },
  };
}

function main(): number {
  const options = parseArgs(process.argv.slice(2));
  const catalog = loadCatalog(options.db);

  if (options.sql) {
    try {
      const result = runOne(options.sql, catalog, options);
      process.stdout.write(JSON.stringify(result) + "\n");
      return 0;
    } catch (error) {
      const message = error instanceof SqlError ? error.message : String(error);
      process.stdout.write(JSON.stringify({ error: message }) + "\n");
      return 1;
    }
  }

  if (!options.file) {
    process.stderr.write("usage: --sql <query> | --file <queries.jsonl> [--db dir] [--planner cost|naive]\n");
    return 2;
  }

  const lines = readFileSync(options.file, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let id = "";
    let sql = "";
    try {
      const record = JSON.parse(trimmed) as { id?: string; sql?: string };
      id = record.id ?? "";
      sql = record.sql ?? "";
      const result = runOne(sql, catalog, options);
      process.stdout.write(JSON.stringify({ id, ...result }) + "\n");
    } catch (error) {
      const message = error instanceof SqlError ? error.message : String(error);
      process.stdout.write(JSON.stringify({ id, error: message }) + "\n");
    }
  }
  return 0;
}

process.exit(main());
