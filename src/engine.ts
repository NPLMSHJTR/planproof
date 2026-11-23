/**
 * Storage, planning, and execution for planproof.
 *
 * The planner enumerates left-deep join orders (four tables or fewer, so at most
 * 24 permutations) and scores each by the sum of intermediate cardinalities.
 * The naive planner keeps the order the query was written in. Both share the
 * same executor, so the comparison isolates the ordering decision.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { ColumnType, Expr, Join, Query, SelectItem, TableRef, Value } from "./sql.ts";
import { SqlError } from "./sql.ts";

export type Column = { name: string; type: ColumnType };

export type Table = {
  name: string;
  columns: Column[];
  rows: Value[][];
  ndv: number[];
};

export type Catalog = Map<string, Table>;

export type Plan = {
  order: TableRef[];
  predicates: Expr[][];
  estimatedRows: number;
  cost: number;
  considered: number;
  mode: "cost" | "naive";
};

const NUMERIC: ColumnType[] = ["int", "float"];

export function loadCatalog(directory: string): Catalog {
  const catalog: Catalog = new Map();
  for (const file of readdirSync(directory)) {
    if (!file.endsWith(".csv")) continue;
    const name = file.slice(0, -4);
    const text = readFileSync(join(directory, file), "utf8").replace(/\r\n/g, "\n");
    const lines = text.split("\n").filter((line) => line.length > 0);
    const header = lines[0].split(",").map((value) => value.trim());
    const raw = lines.slice(1).map((line) => splitCsv(line));
    const columns: Column[] = header.map((column, index) => ({
      name: column,
      type: inferType(raw.map((row) => row[index])),
    }));
    const rows: Value[][] = raw.map((row) =>
      row.map((value, index) => cast(value, columns[index].type)),
    );
    const ndv = columns.map((_, index) => {
      const seen = new Set<string>();
      for (const row of rows) {
        if (row[index] !== null) seen.add(String(row[index]));
        if (seen.size > 200000) break;
      }
      return Math.max(1, seen.size);
    });
    catalog.set(name, { name, columns, rows, ndv });
  }
  return catalog;
}

function splitCsv(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

function inferType(values: string[]): ColumnType {
  let integer = true;
  let numeric = true;
  for (const value of values) {
    if (value === "" || value === "\\N") continue;
    if (!/^-?\d+$/.test(value)) integer = false;
    if (!/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(value)) numeric = false;
    if (!integer && !numeric) break;
  }
  return integer ? "int" : numeric ? "float" : "text";
}

function cast(value: string, type: ColumnType): Value {
  if (value === "" || value === "\\N") return null;
  if (type === "text") return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : value;
}

type Binding = { table: string; column: string; type: ColumnType; index: number };

function bindingsFor(refs: TableRef[], catalog: Catalog): Binding[] {
  const bindings: Binding[] = [];
  for (const ref of refs) {
    const table = catalog.get(ref.name);
    if (!table) throw new SqlError(`unknown table ${ref.name}`);
    for (const column of table.columns) {
      bindings.push({
        table: ref.alias,
        column: column.name,
        type: column.type,
        index: bindings.length,
      });
    }
  }
  return bindings;
}

function resolve(expr: Extract<Expr, { kind: "col" }>, bindings: Binding[]): Binding {
  const matches = bindings.filter(
    (binding) =>
      binding.column === expr.name && (expr.table === undefined || binding.table === expr.table),
  );
  if (matches.length === 0) throw new SqlError(`unknown column ${expr.name}`);
  if (matches.length > 1) throw new SqlError(`ambiguous column ${expr.name}`);
  return matches[0];
}

type Row = Value[];

function truthy(value: Value): boolean {
  if (value === null) return false;
  if (typeof value === "number") return value !== 0;
  return value.length > 0;
}

function compare(left: Value, right: Value): number {
  if (left === null && right === null) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

type Scalar = (row: Row) => Value;

export function compileScalar(expr: Expr, bindings: Binding[]): Scalar {
  switch (expr.kind) {
    case "lit":
      return () => expr.value;
    case "col": {
      const binding = resolve(expr, bindings);
      return (row) => row[binding.index] ?? null;
    }
    case "un": {
      const inner = compileScalar(expr.expr, bindings);
      if (expr.op === "not") return (row) => (truthy(inner(row)) ? 0 : 1);
      return (row) => {
        const value = inner(row);
        return typeof value === "number" ? -value : null;
      };
    }
    case "isnull": {
      const inner = compileScalar(expr.expr, bindings);
      return (row) => {
        const missing = inner(row) === null;
        return (expr.negated ? !missing : missing) ? 1 : 0;
      };
    }
    case "in": {
      const inner = compileScalar(expr.expr, bindings);
      const list = expr.list.map((item) => compileScalar(item, bindings));
      return (row) => {
        const value = inner(row);
        if (value === null) return null;
        const found = list.some((item) => compare(value, item(row)) === 0);
        return (expr.negated ? !found : found) ? 1 : 0;
      };
    }
    case "bin":
      return compileBinary(expr, bindings);
    default:
      throw new SqlError("aggregate not allowed here");
  }
}

function compileBinary(expr: Extract<Expr, { kind: "bin" }>, bindings: Binding[]): Scalar {
  const left = compileScalar(expr.left, bindings);
  const right = compileScalar(expr.right, bindings);
  const op = expr.op;
  if (op === "and" || op === "or") {
    return (row) => {
      const a = left(row);
      const b = right(row);
      if (op === "and") {
        if (a !== null && !truthy(a)) return 0;
        if (b !== null && !truthy(b)) return 0;
        if (a === null || b === null) return null;
        return 1;
      }
      if (a !== null && truthy(a)) return 1;
      if (b !== null && truthy(b)) return 1;
      if (a === null || b === null) return null;
      return 0;
    };
  }
  if (["=", "<>", "<", "<=", ">", ">="].includes(op)) {
    return (row) => {
      const a = left(row);
      const b = right(row);
      if (a === null || b === null) return null;
      const order = compare(a, b);
      const result =
        op === "=" ? order === 0
          : op === "<>" ? order !== 0
            : op === "<" ? order < 0
              : op === "<=" ? order <= 0
                : op === ">" ? order > 0
                  : order >= 0;
      return result ? 1 : 0;
    };
  }
  return (row) => {
    const a = left(row);
    const b = right(row);
    if (a === null || b === null) return null;
    if (typeof a !== "number" || typeof b !== "number") return null;
    switch (op) {
      case "+":
        return a + b;
      case "-":
        return a - b;
      case "*":
        return a * b;
      case "/":
        if (b === 0) return null;
        return Number.isInteger(a) && Number.isInteger(b) ? Math.trunc(a / b) : a / b;
      default:
        return null;
    }
  };
}

function tablesOf(expr: Expr): Set<string> {
  const tables = new Set<string>();
  const walk = (node: Expr): void => {
    switch (node.kind) {
      case "col":
        if (node.table) tables.add(node.table);
        break;
      case "bin":
        walk(node.left);
        walk(node.right);
        break;
      case "un":
        walk(node.expr);
        break;
      case "isnull":
        walk(node.expr);
        break;
      case "in":
        walk(node.expr);
        node.list.forEach(walk);
        break;
      case "agg":
        if (node.arg) walk(node.arg);
        break;
      default:
        break;
    }
  };
  walk(expr);
  return tables;
}

function flattenAnd(expr: Expr | undefined): Expr[] {
  if (!expr) return [];
  if (expr.kind === "bin" && expr.op === "and") {
    return [...flattenAnd(expr.left), ...flattenAnd(expr.right)];
  }
  return [expr];
}

type Meta = Binding & { ndv: number };

function metaFor(refs: TableRef[], catalog: Catalog): Meta[] {
  const meta: Meta[] = [];
  for (const ref of refs) {
    const table = catalog.get(ref.name);
    if (!table) throw new SqlError(`unknown table ${ref.name}`);
    table.columns.forEach((column, index) => {
      meta.push({
        table: ref.alias,
        column: column.name,
        type: column.type,
        index: meta.length,
        ndv: table.ndv[index] ?? 1,
      });
    });
  }
  return meta;
}

function lookup(expr: Extract<Expr, { kind: "col" }>, meta: Meta[]): Meta | null {
  const matches = meta.filter(
    (item) => item.column === expr.name && (expr.table === undefined || item.table === expr.table),
  );
  return matches.length === 1 ? matches[0] : null;
}

function selectivity(expr: Expr, meta: Meta[]): number {
  if (expr.kind !== "bin") return 0.5;
  const op = expr.op;
  if (op === "and") return selectivity(expr.left, meta) * selectivity(expr.right, meta);
  if (op === "or") {
    const a = selectivity(expr.left, meta);
    const b = selectivity(expr.right, meta);
    return Math.min(1, a + b - a * b);
  }
  if (!["=", "<>", "<", "<=", ">", ">="].includes(op)) return 0.5;
  const leftCol = expr.left.kind === "col" ? expr.left : null;
  const rightCol = expr.right.kind === "col" ? expr.right : null;
  const leftLiteral = expr.left.kind === "lit" ? expr.left : null;
  const rightLiteral = expr.right.kind === "lit" ? expr.right : null;

  if (leftCol && rightCol) {
    const a = lookup(leftCol, meta);
    const b = lookup(rightCol, meta);
    if (a && b) return 1 / Math.max(a.ndv, b.ndv);
    return 0.5;
  }
  if (leftLiteral && rightLiteral) return 1;
  const column = leftCol ?? rightCol;
  if (column) {
    const binding = lookup(column, meta);
    if (!binding) return 0.5;
    if (op === "=") return 1 / Math.max(1, binding.ndv);
    if (op === "<>" ) return 1 - 1 / Math.max(1, binding.ndv);
    return 0.33;
  }
  return 0.5;
}

function inSelectivity(expr: Extract<Expr, { kind: "in" }>, meta: Meta[]): number {
  const column = expr.expr.kind === "col" ? lookup(expr.expr, meta) : null;
  if (!column) return 0.5;
  return Math.min(1, expr.list.length / Math.max(1, column.ndv));
}

function predicateSelectivity(expr: Expr, meta: Meta[]): number {
  if (expr.kind === "in") return inSelectivity(expr, meta);
  if (expr.kind === "isnull") return 0.1;
  if (expr.kind === "un") return 0.5;
  return selectivity(expr, meta);
}

function joinSelectivity(on: Expr, meta: Meta[], joined: Set<string>): number {
  let result = 1;
  for (const conjunct of flattenAnd(on)) {
    if (conjunct.kind === "bin" && conjunct.op === "=" &&
        conjunct.left.kind === "col" && conjunct.right.kind === "col") {
      const left = lookup(conjunct.left, meta);
      const right = lookup(conjunct.right, meta);
      if (left && right && (joined.has(left.table) !== joined.has(right.table))) {
        result *= 1 / Math.max(1, left.ndv, right.ndv);
        continue;
      }
    }
    result *= predicateSelectivity(conjunct, meta);
  }
  return Math.max(0.00001, result);
}

export function plan(query: Query, catalog: Catalog, mode: "cost" | "naive"): Plan {
  const refs = [query.from, ...query.joins.map((join) => join.table)];
  if (refs.length > 4) throw new SqlError("at most four tables are supported");
  const meta = metaFor(refs, catalog);

  const rowsOf = (ref: TableRef): Table => {
    const table = catalog.get(ref.name);
    if (!table) throw new SqlError(`unknown table ${ref.name}`);
    return table;
  };

  // Join conditions form an undirected graph: a clause may be written on either
  // side of the pair, so it is stored as an edge rather than as a property of
  // the table it happens to be attached to.
  type Edge = { aliases: Set<string>; expr: Expr };
  const edges: Edge[] = [];
  for (const join of query.joins) {
    for (const conjunct of flattenAnd(join.on)) {
      const aliases = tablesOf(conjunct);
      if (aliases.size === 0) continue;
      edges.push({ aliases, expr: conjunct });
    }
  }

  const singleTable = new Map<string, Expr[]>();
  for (const predicate of flattenAnd(query.where)) {
    const tables = tablesOf(predicate);
    if (tables.size === 1) {
      const alias = [...tables][0];
      singleTable.set(alias, [...(singleTable.get(alias) ?? []), predicate]);
    }
  }

  const baseRows = new Map<string, number>();
  for (const ref of refs) {
    let rows = rowsOf(ref).rows.length;
    for (const predicate of singleTable.get(ref.alias) ?? []) {
      rows *= predicateSelectivity(predicate, meta);
    }
    baseRows.set(ref.alias, Math.max(1, rows));
  }

  const applicable = (alias: string, joined: Set<string>): Edge[] =>
    edges.filter(
      (edge) =>
        edge.aliases.has(alias) &&
        [...edge.aliases].every((name) => name === alias || joined.has(name)),
    );

  const candidateOrders: TableRef[][] = [];
  if (mode === "naive") {
    candidateOrders.push(refs);
  } else {
    const permute = (remaining: TableRef[], chosen: TableRef[]): void => {
      if (remaining.length === 0) {
        candidateOrders.push(chosen);
        return;
      }
      for (let index = 0; index < remaining.length; index++) {
        permute(
          [...remaining.slice(0, index), ...remaining.slice(index + 1)],
          [...chosen, remaining[index]],
        );
      }
    };
    permute(refs, []);
  }

  let best: Plan | null = null;
  for (const order of candidateOrders) {
    let cardinality = baseRows.get(order[0].alias) ?? 1;
    let cost = cardinality;
    const joined = new Set<string>([order[0].alias]);
    const predicates: Expr[][] = [[]];
    let valid = true;
    for (let index = 1; index < order.length; index++) {
      const alias = order[index].alias;
      const conditions = applicable(alias, joined);
      if (conditions.length === 0) {
        valid = false;
        break;
      }
      let factor = 1;
      for (const edge of conditions) {
        factor *= edge.aliases.size === 2
          ? joinEdgeSelectivity(edge.expr, meta)
          : predicateSelectivity(edge.expr, meta);
      }
      cardinality *= (baseRows.get(alias) ?? 1) * Math.max(0.00001, factor);
      cost += cardinality;
      joined.add(alias);
      predicates.push(conditions.map((edge) => edge.expr));
    }
    if (!valid) continue;
    if (!best || cost < best.cost) {
      best = {
        order,
        predicates,
        estimatedRows: Math.max(1, Math.round(cardinality)),
        cost,
        considered: candidateOrders.length,
        mode,
      };
    }
  }
  if (!best) throw new SqlError("query does not contain a connected join order");
  return best;
}

function joinEdgeSelectivity(expr: Expr, meta: Meta[]): number {
  if (expr.kind === "bin" && expr.op === "=" && expr.left.kind === "col" && expr.right.kind === "col") {
    const left = lookup(expr.left, meta);
    const right = lookup(expr.right, meta);
    if (left && right) return 1 / Math.max(1, left.ndv, right.ndv);
  }
  return predicateSelectivity(expr, meta);
}

export type Result = { columns: string[]; rows: Value[][]; scanned: number; stages: number[] };

export function execute(query: Query, plan: Plan, catalog: Catalog): Result {
  const bindings = bindingsFor(plan.order, catalog);
  const indexOf = new Map<string, number>();
  bindings.forEach((binding, index) => {
    indexOf.set(`${binding.table}.${binding.column}`, index);
  });

  const whereConjuncts = flattenAnd(query.where);
  const remainingPredicates = whereConjuncts.filter((expr) => {
    const tables = tablesOf(expr);
    return tables.size !== 1;
  });

  let rows: Row[] = [];
  let scanned = 0;
  const stages: number[] = [];

  for (let position = 0; position < plan.order.length; position++) {
    const ref = plan.order[position];
    const table = catalog.get(ref.name);
    if (!table) throw new SqlError(`unknown table ${ref.name}`);
    const offset = position === 0 ? 0 : bindings.findIndex((binding) => binding.table === ref.alias);
    const localFilters = whereConjuncts.filter((expr) => {
      const tables = tablesOf(expr);
      return tables.size === 1 && tables.has(ref.alias);
    });

    if (position === 0) {
      for (const source of table.rows) {
        scanned += 1;
        const row: Row = new Array(bindings.length).fill(null);
        for (let index = 0; index < table.columns.length; index++) {
          row[offset + index] = source[index];
        }
        if (localFilters.every((expr) => truthy(compileScalar(expr, bindings)(row)))) {
          rows.push(row);
        }
      }
      continue;
    }

    const conditions = plan.predicates[position] ?? [];
    if (conditions.length === 0) {
      throw new SqlError(`join order is not connected at ${ref.alias}`);
    }
    const joinedBefore = new Set(plan.order.slice(0, position).map((item) => item.alias));
    const equi = findEquiJoin(conditions, bindings, ref.alias, indexOf, joinedBefore);
    const predicateFns = conditions.map((condition) => compileScalar(condition, bindings));
    const next: Row[] = [];

    if (equi) {
      const map = new Map<string, Row[]>();
      for (const source of table.rows) {
        scanned += 1;
        const row: Row = new Array(bindings.length).fill(null);
        for (let index = 0; index < table.columns.length; index++) {
          row[offset + index] = source[index];
        }
        if (!localFilters.every((expr) => truthy(compileScalar(expr, bindings)(row)))) continue;
        const key = String(row[equi.rightIndex]);
        const bucket = map.get(key);
        if (bucket) bucket.push(row);
        else map.set(key, [row]);
      }
      for (const left of rows) {
        const key = String(left[equi.leftIndex]);
        const bucket = map.get(key);
        if (!bucket) continue;
        for (const right of bucket) {
          const combined = left.slice();
          for (let index = 0; index < table.columns.length; index++) {
            combined[offset + index] = right[offset + index];
          }
          if (predicateFns.every((fn) => truthy(fn(combined)))) next.push(combined);
        }
      }
    } else {
      for (const left of rows) {
        for (const source of table.rows) {
          scanned += 1;
          const row = left.slice();
          for (let index = 0; index < table.columns.length; index++) {
            row[offset + index] = source[index];
          }
          if (!predicateFns.every((fn) => truthy(fn(row)))) continue;
          if (!localFilters.every((expr) => truthy(compileScalar(expr, bindings)(row)))) continue;
          next.push(row);
        }
      }
    }
    rows = next;
    stages.push(rows.length);
  }

  for (const predicate of remainingPredicates) {
    const evaluate = compileScalar(predicate, bindings);
    rows = rows.filter((row) => truthy(evaluate(row)));
  }

  const aliasToExpr = new Map<string, Expr>();
  for (const item of query.items) {
    if (item.alias) aliasToExpr.set(item.alias, item.expr);
  }
  // Aliases can appear inside an expression, not only at its root:
  // `HAVING n > 400` refers to `COUNT(*) AS n`.
  const expandAlias = (expr: Expr): Expr => {
    switch (expr.kind) {
      case "col":
        return !expr.table && aliasToExpr.has(expr.name) ? aliasToExpr.get(expr.name)! : expr;
      case "bin":
        return { ...expr, left: expandAlias(expr.left), right: expandAlias(expr.right) };
      case "un":
        return { ...expr, expr: expandAlias(expr.expr) };
      case "isnull":
        return { ...expr, expr: expandAlias(expr.expr) };
      case "in":
        return { ...expr, expr: expandAlias(expr.expr), list: expr.list.map(expandAlias) };
      default:
        return expr;
    }
  };

  const hasAggregate =
    query.items.some((item) => containsAggregate(item.expr)) ||
    query.groupBy.length > 0 ||
    (query.having !== undefined && containsAggregate(query.having));

  let outputRows: Value[][];
  let outputColumns: string[];

  if (!hasAggregate) {
    outputColumns = query.items.map((item, index) => label(item, index));
    outputRows = rows.map((row) =>
      query.items.map((item) => compileScalar(item.expr, bindings)(row)),
    );
    if (query.orderBy.length > 0 && query.groupBy.length === 0) {
      const keys = query.orderBy.map((order) => compileScalar(expandAlias(order.expr), bindings));
      const indexed = rows.map((row, index) => ({ row, index }));
      indexed.sort((a, b) => {
        for (let position = 0; position < keys.length; position++) {
          const order = compare(keys[position](a.row), keys[position](b.row));
          if (order !== 0) return query.orderBy[position].desc ? -order : order;
        }
        return a.index - b.index;
      });
      outputRows = indexed.map((entry) => query.items.map((item) => compileScalar(item.expr, bindings)(entry.row)));
    }
  } else {
    const groups = new Map<string, Row[]>();
    const keyExprs = query.groupBy.map((expr) => compileScalar(expandAlias(expr), bindings));
    if (keyExprs.length === 0) {
      groups.set("", rows);
    } else {
      for (const row of rows) {
        const key = JSON.stringify(keyExprs.map((expr) => expr(row)));
        const bucket = groups.get(key);
        if (bucket) bucket.push(row);
        else groups.set(key, [row]);
      }
    }
    const projected: { row: Value[]; group: Row[] }[] = [];
    for (const bucket of groups.values()) {
      const values = query.items.map((item) => evaluateWithAggregates(item.expr, bindings, bucket));
      projected.push({ row: values, group: bucket });
    }

    if (query.having) {
      const keep = projected.filter((entry) =>
        truthy(evaluateWithAggregates(expandAlias(query.having!), bindings, entry.group)),
      );
      projected.length = 0;
      projected.push(...keep);
    }

    if (query.orderBy.length > 0) {
      const decorated = projected.map((entry, index) => ({ entry, index }));
      decorated.sort((a, b) => {
        for (const order of query.orderBy) {
          const expr = expandAlias(order.expr);
          const left = containsAggregate(expr)
            ? evaluateWithAggregates(expr, bindings, a.entry.group)
            : compileScalar(expr, bindings)(a.entry.group[0] ?? new Array(bindings.length).fill(null));
          const right = containsAggregate(expr)
            ? evaluateWithAggregates(expr, bindings, b.entry.group)
            : compileScalar(expr, bindings)(b.entry.group[0] ?? new Array(bindings.length).fill(null));
          const order2 = compare(left, right);
          if (order2 !== 0) return order.desc ? -order2 : order2;
        }
        return a.index - b.index;
      });
      outputRows = decorated.map((item) => item.entry.row);
    } else {
      outputRows = projected.map((entry) => entry.row);
    }
    outputColumns = query.items.map((item, index) => label(item, index));
  }

  if (query.distinct) {
    const seen = new Set<string>();
    outputRows = outputRows.filter((row) => {
      const key = JSON.stringify(row);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  if (query.limit !== undefined) {
    outputRows = outputRows.slice(0, query.limit);
  }

  return { columns: outputColumns, rows: outputRows, scanned, stages };
}

function findEquiJoin(
  conditions: Expr[],
  bindings: Binding[],
  alias: string,
  indexOf: Map<string, number>,
  joinedBefore: Set<string>,
): { leftIndex: number; rightIndex: number } | null {
  for (const conjunct of conditions) {
    if (conjunct.kind !== "bin" || conjunct.op !== "=") continue;
    if (conjunct.left.kind !== "col" || conjunct.right.kind !== "col") continue;
    const left = conjunct.left;
    const right = conjunct.right;
    const leftIsNew = left.table === alias;
    const rightIsNew = right.table === alias;
    if (leftIsNew === rightIsNew) continue;
    const oldSideAlias = leftIsNew ? right.table : left.table;
    if (!oldSideAlias || !joinedBefore.has(oldSideAlias)) continue;
    const newSide = leftIsNew ? left : right;
    const oldSide = leftIsNew ? right : left;
    const newIndex = indexOf.get(`${newSide.table}.${newSide.name}`);
    const oldIndex = oldSide.table
      ? indexOf.get(`${oldSide.table}.${oldSide.name}`)
      : bindings.findIndex((binding) => binding.column === oldSide.name);
    if (newIndex === undefined || oldIndex < 0) continue;
    return { leftIndex: oldIndex, rightIndex: newIndex };
  }
  return null;
}

function containsAggregate(expr: Expr): boolean {
  switch (expr.kind) {
    case "agg":
      return true;
    case "bin":
      return containsAggregate(expr.left) || containsAggregate(expr.right);
    case "un":
      return containsAggregate(expr.expr);
    case "isnull":
      return containsAggregate(expr.expr);
    case "in":
      return containsAggregate(expr.expr) || expr.list.some(containsAggregate);
    default:
      return false;
  }
}

function evaluateWithAggregates(expr: Expr, bindings: Binding[], rows: Row[]): Value {
  switch (expr.kind) {
    case "agg":
      return aggregate(expr.fn, expr.arg, bindings, rows);
    case "bin": {
      const left = evaluateWithAggregates(expr.left, bindings, rows);
      const right = evaluateWithAggregates(expr.right, bindings, rows);
      const compiled = compileBinary({ kind: "bin", op: expr.op, left: { kind: "lit", value: left }, right: { kind: "lit", value: right } }, bindings);
      return compiled([]);
    }
    case "un": {
      const value = evaluateWithAggregates(expr.expr, bindings, rows);
      return compileScalar({ kind: "un", op: expr.op, expr: { kind: "lit", value } }, bindings)([]);
    }
    case "isnull": {
      const value = evaluateWithAggregates(expr.expr, bindings, rows);
      return value === null ? (expr.negated ? 0 : 1) : expr.negated ? 1 : 0;
    }
    case "in": {
      const value = evaluateWithAggregates(expr.expr, bindings, rows);
      if (value === null) return null;
      const found = expr.list.some((item) => compare(value, evaluateWithAggregates(item, bindings, rows)) === 0);
      return (expr.negated ? !found : found) ? 1 : 0;
    }
    default:
      return compileScalar(expr, bindings)(rows[0] ?? new Array(bindings.length).fill(null));
  }
}

function aggregate(fn: string, arg: Expr | null, bindings: Binding[], rows: Row[]): Value {
  if (fn === "count") {
    if (!arg) return rows.length;
    const evaluate = compileScalar(arg, bindings);
    return rows.reduce((total, row) => total + (evaluate(row) === null ? 0 : 1), 0);
  }
  if (!arg) return null;
  const evaluate = compileScalar(arg, bindings);
  const values: number[] = [];
  for (const row of rows) {
    const value = evaluate(row);
    if (value !== null && typeof value === "number") values.push(value);
  }
  if (fn === "sum") return values.length === 0 ? null : values.reduce((a, b) => a + b, 0);
  if (fn === "avg") return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
  if (fn === "min") return values.length === 0 ? null : Math.min(...values);
  if (fn === "max") return values.length === 0 ? null : Math.max(...values);
  return null;
}

function label(item: SelectItem, index: number): string {
  if (item.alias) return item.alias;
  if (item.expr.kind === "col") return item.expr.name;
  if (item.expr.kind === "agg") return `${item.expr.fn}(${item.expr.arg?.kind === "col" ? item.expr.arg.name : "*"})`;
  return `column${index + 1}`;
}
