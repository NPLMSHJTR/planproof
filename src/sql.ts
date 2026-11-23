/**
 * Lexer, AST, and recursive-descent parser for the planproof SQL subset.
 *
 * The subset is deliberately small: single SELECT, inner joins, filters,
 * grouping, HAVING, ORDER BY, LIMIT. Every construct here has an exact
 * counterpart in SQLite, which is what makes differential testing meaningful.
 */

export type Value = number | string | null;
export type ColumnType = "int" | "float" | "text";

export type Expr =
  | { kind: "col"; table?: string; name: string }
  | { kind: "lit"; value: Value }
  | { kind: "bin"; op: string; left: Expr; right: Expr }
  | { kind: "un"; op: string; expr: Expr }
  | { kind: "isnull"; expr: Expr; negated: boolean }
  | { kind: "in"; expr: Expr; list: Expr[]; negated: boolean }
  | { kind: "agg"; fn: string; arg: Expr | null };

export type SelectItem = { expr: Expr; alias?: string };

export type TableRef = { name: string; alias: string };

export type Join = {
  table: TableRef;
  on: Expr;
};

export type OrderItem = { expr: Expr; desc: boolean };

export type Query = {
  distinct: boolean;
  items: SelectItem[];
  from: TableRef;
  joins: Join[];
  where?: Expr;
  groupBy: Expr[];
  having?: Expr;
  orderBy: OrderItem[];
  limit?: number;
};

type Token = { type: "ident" | "number" | "string" | "op" | "keyword"; value: string; pos: number };

const KEYWORDS = new Set([
  "select", "distinct", "from", "join", "inner", "on", "where", "group", "by",
  "having", "order", "asc", "desc", "limit", "as", "and", "or", "not", "is",
  "null", "in", "count", "sum", "avg", "min", "max",
]);

export class SqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqlError";
  }
}

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "-" && sql[index + 1] === "-") {
      while (index < sql.length && sql[index] !== "\n") index += 1;
      continue;
    }
    if (char === "'") {
      let value = "";
      index += 1;
      while (index < sql.length) {
        if (sql[index] === "'" && sql[index + 1] === "'") {
          value += "'";
          index += 2;
        } else if (sql[index] === "'") {
          index += 1;
          break;
        } else {
          value += sql[index];
          index += 1;
        }
      }
      tokens.push({ type: "string", value, pos: index });
      continue;
    }
    if (/[0-9]/.test(char) || (char === "." && /[0-9]/.test(sql[index + 1] ?? ""))) {
      let value = "";
      while (index < sql.length && /[0-9.]/.test(sql[index])) {
        value += sql[index];
        index += 1;
      }
      tokens.push({ type: "number", value, pos: index });
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let value = "";
      while (index < sql.length && /[A-Za-z0-9_]/.test(sql[index])) {
        value += sql[index];
        index += 1;
      }
      const lower = value.toLowerCase();
      tokens.push({ type: KEYWORDS.has(lower) ? "keyword" : "ident", value: lower, pos: index });
      continue;
    }
    const two = sql.slice(index, index + 2);
    if (["<>", "<=", ">=", "!="].includes(two)) {
      tokens.push({ type: "op", value: two === "!=" ? "<>" : two, pos: index });
      index += 2;
      continue;
    }
    if ("+-*/(),.=<>".includes(char)) {
      tokens.push({ type: "op", value: char, pos: index });
      index += 1;
      continue;
    }
    throw new SqlError(`unexpected character ${JSON.stringify(char)} at ${index}`);
  }
  return tokens;
}

class Parser {
  private position = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parseQuery(): Query {
    this.expectKeyword("select");
    let distinct = false;
    if (this.matchKeyword("distinct")) distinct = true;
    const items: SelectItem[] = [];
    do {
      const expr = this.parseExpr();
      let alias: string | undefined;
      if (this.matchKeyword("as")) {
        alias = this.expectIdent();
      }
      items.push({ expr, alias });
    } while (this.matchOp(","));

    this.expectKeyword("from");
    const from = this.parseTableRef();
    const joins: Join[] = [];
    while (true) {
      if (this.matchKeyword("inner")) {
        this.expectKeyword("join");
      } else if (!this.matchKeyword("join")) {
        break;
      }
      const table = this.parseTableRef();
      this.expectKeyword("on");
      joins.push({ table, on: this.parseExpr() });
    }

    let where: Expr | undefined;
    if (this.matchKeyword("where")) where = this.parseExpr();

    const groupBy: Expr[] = [];
    if (this.matchKeyword("group")) {
      this.expectKeyword("by");
      do {
        groupBy.push(this.parseExpr());
      } while (this.matchOp(","));
    }

    let having: Expr | undefined;
    if (this.matchKeyword("having")) having = this.parseExpr();

    const orderBy: OrderItem[] = [];
    if (this.matchKeyword("order")) {
      this.expectKeyword("by");
      do {
        const expr = this.parseExpr();
        let desc = false;
        if (this.matchKeyword("desc")) desc = true;
        else this.matchKeyword("asc");
        orderBy.push({ expr, desc });
      } while (this.matchOp(","));
    }

    let limit: number | undefined;
    if (this.matchKeyword("limit")) {
      const token = this.tokens[this.position];
      if (!token || token.type !== "number") throw new SqlError("LIMIT needs a number");
      this.position += 1;
      limit = Number(token.value);
    }

    if (this.position !== this.tokens.length) {
      throw new SqlError(`unexpected token ${JSON.stringify(this.tokens[this.position]?.value)}`);
    }
    return { distinct, items, from, joins, where, groupBy, having, orderBy, limit };
  }

  private parseTableRef(): TableRef {
    const name = this.expectIdent();
    let alias = name;
    if (this.matchKeyword("as")) {
      alias = this.expectIdent();
    } else if (this.tokens[this.position]?.type === "ident") {
      alias = this.expectIdent();
    }
    return { name, alias };
  }

  private parseExpr(): Expr {
    return this.parseOr();
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.matchKeyword("or")) {
      left = { kind: "bin", op: "or", left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseNot();
    while (this.matchKeyword("and")) {
      left = { kind: "bin", op: "and", left, right: this.parseNot() };
    }
    return left;
  }

  private parseNot(): Expr {
    if (this.matchKeyword("not")) {
      return { kind: "un", op: "not", expr: this.parseNot() };
    }
    return this.parseComparison();
  }

  private parseComparison(): Expr {
    let left = this.parseAdditive();
    const token = this.tokens[this.position];
    if (token?.type === "op" && ["=", "<>", "<", "<=", ">", ">="].includes(token.value)) {
      this.position += 1;
      return { kind: "bin", op: token.value, left, right: this.parseAdditive() };
    }
    if (this.matchKeyword("is")) {
      const negated = this.matchKeyword("not");
      this.expectKeyword("null");
      return { kind: "isnull", expr: left, negated };
    }
    const negated = this.matchKeyword("not");
    if (this.matchKeyword("in")) {
      this.expectOp("(");
      const list: Expr[] = [];
      do {
        list.push(this.parseExpr());
      } while (this.matchOp(","));
      this.expectOp(")");
      return { kind: "in", expr: left, list, negated };
    }
    if (negated) throw new SqlError("unexpected NOT");
    return left;
  }

  private parseAdditive(): Expr {
    let left = this.parseMultiplicative();
    while (true) {
      const token = this.tokens[this.position];
      if (token?.type === "op" && (token.value === "+" || token.value === "-")) {
        this.position += 1;
        left = { kind: "bin", op: token.value, left, right: this.parseMultiplicative() };
      } else {
        break;
      }
    }
    return left;
  }

  private parseMultiplicative(): Expr {
    let left = this.parseUnary();
    while (true) {
      const token = this.tokens[this.position];
      if (token?.type === "op" && (token.value === "*" || token.value === "/")) {
        this.position += 1;
        left = { kind: "bin", op: token.value, left, right: this.parseUnary() };
      } else {
        break;
      }
    }
    return left;
  }

  private parseUnary(): Expr {
    const token = this.tokens[this.position];
    if (token?.type === "op" && (token.value === "-" || token.value === "+")) {
      this.position += 1;
      const expr = this.parseUnary();
      return token.value === "-" ? { kind: "un", op: "-", expr } : expr;
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    const token = this.tokens[this.position];
    if (!token) throw new SqlError("unexpected end of query");
    if (this.matchOp("(")) {
      const expr = this.parseExpr();
      this.expectOp(")");
      return expr;
    }
    if (token.type === "number") {
      this.position += 1;
      return { kind: "lit", value: Number(token.value) };
    }
    if (token.type === "string") {
      this.position += 1;
      return { kind: "lit", value: token.value };
    }
    if (token.type === "keyword" && token.value === "null") {
      this.position += 1;
      return { kind: "lit", value: null };
    }
    if (token.type === "keyword" && ["count", "sum", "avg", "min", "max"].includes(token.value)) {
      this.position += 1;
      this.expectOp("(");
      let arg: Expr | null = null;
      if (!this.matchOp("*")) {
        arg = this.parseExpr();
      }
      this.expectOp(")");
      return { kind: "agg", fn: token.value, arg };
    }
    if (token.type === "ident") {
      this.position += 1;
      if (this.matchOp(".")) {
        return { kind: "col", table: token.value, name: this.expectIdent() };
      }
      return { kind: "col", name: token.value };
    }
    throw new SqlError(`unexpected token ${JSON.stringify(token.value)}`);
  }

  private matchKeyword(word: string): boolean {
    const token = this.tokens[this.position];
    if (token?.type === "keyword" && token.value === word) {
      this.position += 1;
      return true;
    }
    return false;
  }

  private expectKeyword(word: string): void {
    if (!this.matchKeyword(word)) {
      throw new SqlError(`expected ${word.toUpperCase()} near ${this.describe()}`);
    }
  }

  private matchOp(op: string): boolean {
    const token = this.tokens[this.position];
    if (token?.type === "op" && token.value === op) {
      this.position += 1;
      return true;
    }
    return false;
  }

  private expectOp(op: string): void {
    if (!this.matchOp(op)) {
      throw new SqlError(`expected ${op} near ${this.describe()}`);
    }
  }

  private expectIdent(): string {
    const token = this.tokens[this.position];
    if (token?.type !== "ident") {
      throw new SqlError(`expected identifier near ${this.describe()}`);
    }
    this.position += 1;
    return token.value;
  }

  private describe(): string {
    const token = this.tokens[this.position];
    return token ? JSON.stringify(token.value) : "end of query";
  }
}

export function parse(sql: string): Query {
  return new Parser(tokenize(sql)).parseQuery();
}
