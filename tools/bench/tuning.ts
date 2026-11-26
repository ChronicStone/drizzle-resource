import type { Pool } from "pg";
import { makeCheck, type IndexFindingLike } from "./resources.ts";

export type Tuning = {
  schema: string;
  resource: string;
  /** What `checkIndexes({ live: true })` said about the out-of-the-box state, errors and warnings. */
  before: Array<{ level: string; rule: string; fields: string[]; fix: string | null }>;
  /** The `fix.sql` statements applied, in order. */
  applied: string[];
  /**
   * What the check described in words but gave no SQL for, and the statement that does what it says.
   * Only listed when the check really reported that rule.
   */
  byHand: Array<{ rule: string; advice: string; sql: string }>;
  /** What it said after applying them. */
  after: Array<{ level: string; rule: string; fields: string[]; fix: string | null }>;
  /** True when no `error` finding is left. */
  noErrorRemains: boolean;
};

const brief = (findings: IndexFindingLike[]) =>
  findings
    .filter((f) => f.level !== "info")
    .map((f) => ({ level: f.level, rule: f.rule, fields: f.fields, fix: f.fix?.sql ?? null }));

/** Statements in a `fix.sql`: one per line, each ending in a semicolon. */
const statements = (sql: string) =>
  sql
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Tunes a schema the way the docs tell a reader to: ask `engine.checkIndexes({ live: true })`
 * about the resource, run every `fix.sql` of an error or a warning, ask again.
 */
export async function tune(
  pool: Pool,
  schema: string,
  shape: { scoped: boolean; denormalized: boolean },
  resource: string,
  byHand: Array<{ rule: string; sql: string }> = [],
): Promise<Tuning> {
  const check = () => makeCheck(pool, schema, shape).checkIndexes({ live: true });
  const first = await check();
  const applied: string[] = [];
  for (const finding of first)
    if ((finding.level === "error" || finding.level === "warn") && finding.fix?.sql)
      for (const statement of statements(finding.fix.sql)) {
        await pool.query(statement);
        applied.push(statement);
      }
  const manual: Tuning["byHand"] = [];
  for (const finding of first)
    for (const step of byHand)
      if (finding.rule === step.rule && !finding.fix?.sql) {
        await pool.query(step.sql);
        manual.push({ rule: step.rule, advice: finding.message, sql: step.sql });
      }
  if (applied.length || manual.length) {
    await pool.query(`analyze "${schema}".orders`);
    await pool.query(`analyze "${schema}".customers`);
  }
  const after = await check();
  return {
    schema,
    resource,
    before: brief(first),
    applied,
    byHand: manual,
    after: brief(after),
    noErrorRemains: !after.some((f) => f.level === "error"),
  };
}
