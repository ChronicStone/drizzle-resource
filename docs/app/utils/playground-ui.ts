/**
 * What the playground UI needs to know about the sample `orders` resource, plus the helpers
 * that turn a request, its SQL and the resource definition into annotated views.
 */
import { hl, hlMarked } from "../components/landing/px";
import type { PlaygroundRequest } from "./playground-request";
import type { createPlaygroundClient } from "./playground.client";

export type PlaygroundClient = Awaited<ReturnType<typeof createPlaygroundClient>>;
export type PlaygroundResult = Awaited<ReturnType<PlaygroundClient["run"]>>;
export type Condition = { type: "condition"; key: string; operator: string; value: unknown };
export type Group = { type: "group"; combinator: "and" | "or"; children: FilterNode[] };
export type FilterNode = Condition | Group;
export type FieldKind = "text" | "enum" | "number" | "date";

/* ---------- the sample resource ---------- */
export const STATUSES = ["pending", "processing", "shipped", "cancelled"];
export const CATEGORIES = ["accessories", "audio", "laptops", "monitors", "networking", "storage"];

export const FIELDS: Record<string, { kind: FieldKind; values?: string[] }> = {
  status: { kind: "enum", values: STATUSES },
  reference: { kind: "text" },
  totalAmount: { kind: "number" },
  createdAt: { kind: "date" },
  "customer.name": { kind: "text" },
  "orderLines.quantity": { kind: "number" },
  "orderLines.product.name": { kind: "text" },
  "orderLines.product.sku": { kind: "text" },
  "orderLines.product.category": { kind: "enum", values: CATEGORIES },
};

/** fields grouped by where they live, for the field menu */
export const FIELD_GROUPS: { label: string; keys: string[] }[] = [
  { label: "Order", keys: ["status", "reference", "totalAmount", "createdAt"] },
  { label: "Customer", keys: ["customer.name"] },
  { label: "Order lines", keys: ["orderLines.quantity"] },
  {
    label: "Product",
    keys: ["orderLines.product.name", "orderLines.product.sku", "orderLines.product.category"],
  },
];

export const KIND_ICON: Record<FieldKind, string> = {
  enum: "i-lucide-list",
  text: "i-lucide-type",
  number: "i-lucide-hash",
  date: "i-lucide-calendar",
};

export const OPERATORS: Record<FieldKind, string[]> = {
  enum: ["isAnyOf", "is", "isNot"],
  text: ["contains", "is", "isNot", "isAnyOf"],
  number: ["gte", "lte", "gt", "lt", "is", "between"],
  date: ["after", "before", "between"],
};

export const OP_LABEL: Record<string, string> = {
  is: "is",
  isNot: "is not",
  isAnyOf: "is any of",
  contains: "contains",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  between: "between",
  before: "before",
  after: "after",
};

export const SORT_DISABLED = "orderLines.product.name";
export const SEARCH_ALLOWED = [
  "reference",
  "customer.name",
  "orderLines.product.name",
  "orderLines.product.sku",
];
export const SEARCH_DEFAULTS = ["reference", "customer.name"];
export const FACETS_ALLOWED = ["status", "orderLines.product.category", "customer.name"];
export const PAGE_SIZES = [10, 25, 50];

export function kindOf(key: string): FieldKind {
  return FIELDS[key]?.kind ?? "text";
}

export function draftFor(key: string): Condition {
  const kind = kindOf(key);
  const operator = OPERATORS[kind][0]!;
  return { type: "condition", key, operator, value: emptyValue(kind, operator) };
}

export function emptyValue(kind: FieldKind, operator: string): unknown {
  if (operator === "isAnyOf") return [];
  if (operator === "between") return {};
  if (kind === "number") return null;
  return "";
}

export function isComplete(c: Condition): boolean {
  const v = c.value;
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === "object") return Object.values(v).some((x) => x !== "" && x != null);
  return v !== "" && v !== null && v !== undefined && !Number.isNaN(v);
}

/* ---------- scenarios ---------- */
export function baseRequest(): PlaygroundRequest {
  return {
    context: {},
    pagination: { mode: "offset", pageIndex: 1, pageSize: 10, count: "exact" },
    sorting: [{ key: "createdAt", dir: "desc" }],
    search: { value: "", fields: [] },
    filters: [],
    facets: [
      { key: "status", mode: "exclude-self", limit: 10 },
      { key: "orderLines.product.category", mode: "exclude-self", limit: 10 },
    ],
  };
}

export type HoodTab = "request" | "sql" | "resource" | "response" | "schema";

export const SCENARIOS: {
  id: string;
  label: string;
  text: string;
  docs: string;
  tab: HoodTab;
  make: () => PlaygroundRequest;
}[] = [
  {
    id: "table",
    label: "Data table",
    text: "Newest orders first, with status and category facets. Click a facet, a header or a row and watch the request and the SQL change.",
    docs: "/start/quick-start",
    tab: "request",
    make: baseRequest,
  },
  {
    id: "tree",
    label: "Nested filters",
    text: "Not cancelled, and either at least $20,000 or containing an audio product. The OR group sits inside the top-level AND.",
    docs: "/query/filters",
    tab: "request",
    make: () => ({
      ...baseRequest(),
      filters: [
        { type: "condition", key: "status", operator: "isNot", value: "cancelled" },
        {
          type: "group",
          combinator: "or",
          children: [
            { type: "condition", key: "totalAmount", operator: "gte", value: 20000 },
            {
              type: "condition",
              key: "orderLines.product.category",
              operator: "is",
              value: "audio",
            },
          ],
        },
      ],
    }),
  },
  {
    id: "search",
    label: "Search across relations",
    text: "One search term matched against product names, two relations away from orders. The page ids query joins order lines and products only for this.",
    docs: "/query/search",
    tab: "sql",
    make: () => ({
      ...baseRequest(),
      search: { value: "keyboard", fields: ["orderLines.product.name"] },
    }),
  },
  {
    id: "facets",
    label: "Facet counts",
    text: "Filtered on shipped orders, yet the status facet still counts every status: an exclude-self facet ignores its own filter.",
    docs: "/query/facets",
    tab: "sql",
    make: () => ({
      ...baseRequest(),
      filters: [{ type: "condition", key: "status", operator: "isAnyOf", value: ["shipped"] }],
    }),
  },
  {
    id: "scope",
    label: "Tenant scope",
    text: "The client asks for globex orders, or any order since January 1. The server scope wraps the whole request in AND, so only acme orders from 2026 come back.",
    docs: "/resource/scope",
    tab: "resource",
    make: () => ({
      ...baseRequest(),
      filters: [
        {
          type: "group",
          combinator: "or",
          children: [
            { type: "condition", key: "customer.orgId", operator: "is", value: "globex" },
            { type: "condition", key: "createdAt", operator: "after", value: "2026-01-01" },
          ],
        },
      ],
    }),
  },
  {
    id: "rejected",
    label: "Rejected request",
    text: "A sort on a field the resource disables. The engine throws before any SQL runs, and names the field.",
    docs: "/query/sorting",
    tab: "resource",
    make: () => ({ ...baseRequest(), sorting: [{ key: SORT_DISABLED, dir: "asc" }] }),
  },
];

/* ---------- the call, as code, with changed lines marked ---------- */
export function callLines(request: PlaygroundRequest, summary: boolean): string[] {
  const { context: _context, ...body } = request;
  const json = JSON.stringify(body, null, 2)
    .split("\n")
    .map((line) => line.replace(/^(\s*)"([A-Za-z_]\w*)":/, "$1$2:"));
  return [
    "await orders.query({",
    `  context: { orgId: "acme" }, // from your session, never the body`,
    ...(summary ? ["  summary: true,"] : []),
    `  request: ${json[0]}`,
    ...json.slice(1).map((l) => `  ${l}`),
    "});",
  ];
}

/** Indices of `next` lines that are not part of the longest common subsequence with `prev`. */
export function changedLines(prev: string[], next: string[]): Set<number> {
  const changed = new Set<number>();
  if (!prev.length) return changed;
  const n = prev.length;
  const m = next.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i]![j] =
        prev[i] === next[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  let i = 0;
  let j = 0;
  while (j < m) {
    if (i < n && prev[i] === next[j]) {
      i++;
      j++;
    } else if (i < n && dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
    else changed.add(j++);
  }
  return changed;
}

export const hlLine = (line: string) => hl(line);

/* ---------- SQL statements ---------- */
export type StatementInfo = { kind: string; label: string; note: string };

export function describeStatement(sql: string, request: PlaygroundRequest): StatementInfo {
  const facet = sql.match(/facet_buckets_(\d+)/);
  if (facet) {
    const key = request.facets?.[Number(facet[1])]?.key ?? "facet";
    return {
      kind: "facet",
      label: `facet · ${key}`,
      note: "Counts per value over every matching order. Exclude-self: this facet's own filter is left out so other values stay visible.",
    };
  }
  if (/\bsum\(/i.test(sql))
    return {
      kind: "summary",
      label: "summary",
      note: "Order count and revenue of every matching order, in one aggregate. It also gives the page its exact row count.",
    };
  if (/count_matching_ids/.test(sql))
    return {
      kind: "count",
      label: "count",
      note: "Counts the matching orders once, with the scope, filters and search.",
    };
  if (/"matching_ids"/.test(sql))
    return {
      kind: "ids",
      label: "page ids",
      note: "Filters, searches and sorts, then keeps only the ids of this page. It joins only the relations those paths need.",
    };
  return {
    kind: "rows",
    label: "rows",
    note: "Loads this page's orders by id, with customer and order lines. In this playground it is the resource's own rows step.",
  };
}

function formatSql(sql: string) {
  return sql
    .replace(/\s+/g, " ")
    .replace(
      / (from|where|order by|group by|limit|offset|inner join|left join|union all|select) /gi,
      (_m, kw: string, offset: number) => (offset === 0 ? ` ${kw} ` : `\n${kw} `),
    )
    .replace(/ and /gi, "\n  and ")
    .trim();
}

function escapeHtml(s: string) {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  );
}

function paramHtml(value: unknown) {
  const text = typeof value === "string" ? `'${value}'` : String(value);
  return `<span class="tk-param">${escapeHtml(text.length > 24 ? `${text.slice(0, 22)}…'` : text)}</span>`;
}

/** SQL with its bound values in place. Long `in (…)` lists show their first two values. */
export function sqlHtml(sql: string, params: unknown[]) {
  const parts = formatSql(sql).split("?");
  let out = "";
  let p = 0;
  for (let i = 0; i < parts.length; i++) {
    out += hl(parts[i]!, "sql");
    if (i === parts.length - 1) break;
    let run = 1;
    if (/in \($/i.test(parts[i]!)) while (parts[i + run] === ", ") run++;
    if (run > 3) {
      out += `${paramHtml(params[p])}, ${paramHtml(params[p + 1])}, <span class="tk-more">… ${run - 2} more</span>`;
      p += run;
      i += run - 1;
    } else out += paramHtml(params[p++]);
  }
  return out;
}

/* ---------- the resource, with the parts this request used ---------- */
const RESOURCE = `export const orders = engine.defineResource("orders", {
  relations: {
    ⟦customer|customer: true,⟧
    ⟦lines|orderLines: { with: { product: true } },⟧
  },
  query: {
    ⟦scope|scope: (filters, context) =>
      filters.is("customer.orgId", context.orgId),⟧
    search: {
      ⟦searchAllowed|allowed: ["reference", "customer.name",
        "orderLines.product.name", "orderLines.product.sku"],⟧
      ⟦searchDefaults|defaults: ["reference", "customer.name"],⟧
    },
    filters: {
      ⟦filtersDisabled|disabled: ["deletedAt"],⟧
    },
    sort: {
      ⟦sortDefaults|defaults: [{ key: "createdAt", dir: "desc" }],⟧
      ⟦sortDisabled|disabled: ["orderLines.product.name"],⟧
    },
    facets: {
      ⟦facetsAllowed|allowed: ["status", "customer.name",
        "orderLines.product.category"],⟧
    },
  },
  ⟦summary|summary: (order) => ({
    orders: count(),
    revenue: sum(order.totalAmount),
  }),⟧
  strategy: {
    ⟦rows|rows: ({ ids }) => loadOrdersWithLines(ids),⟧
  },
});`;

function keysOf(nodes: FilterNode[]): string[] {
  return nodes.flatMap((n) => (n.type === "group" ? keysOf(n.children) : [n.key]));
}

export function resourceHtml(request: PlaygroundRequest, summary: boolean, error: string | null) {
  const searching = request.search.value.trim() !== "";
  const searchFields = request.search.fields.length ? request.search.fields : SEARCH_DEFAULTS;
  const paths = [
    ...keysOf(request.filters as FilterNode[]),
    ...request.sorting.map((s) => s.key),
    ...(searching ? searchFields : []),
    ...(request.facets ?? []).map((f) => f.key),
  ];
  const uses = (prefix: string) => [...new Set(paths.filter((p) => p.startsWith(prefix)))];
  const parts: Record<string, { state: "on" | "err"; why: string }> = {
    scope: { state: "on", why: `adds customer.orgId = 'acme' with AND, in every statement` },
    rows: { state: "on", why: "called once with the page's ids" },
  };
  if (uses("customer.").length)
    parts.customer = { state: "on", why: `joined for ${uses("customer.").join(", ")}` };
  if (uses("orderLines.").length)
    parts.lines = { state: "on", why: `joined for ${uses("orderLines.").join(", ")}` };
  if (searching && request.search.fields.length)
    parts.searchAllowed = { state: "on", why: `checked: ${request.search.fields.join(", ")}` };
  if (searching && !request.search.fields.length)
    parts.searchDefaults = { state: "on", why: "used: the request names no search field" };
  if (!request.sorting.length) parts.sortDefaults = { state: "on", why: "used: no sorting sent" };
  if (request.facets?.length)
    parts.facetsAllowed = {
      state: "on",
      why: `checked: ${request.facets.map((f) => f.key).join(", ")}`,
    };
  if (summary) parts.summary = { state: "on", why: "runs because the call passes summary: true" };

  if (error) {
    if (/Sorting field/.test(error))
      parts.sortDisabled = { state: "err", why: "rejected the request" };
    else if (/deletedAt/.test(error))
      parts.filtersDisabled = { state: "err", why: "rejected the request" };
    else if (/search field/.test(error))
      parts.searchAllowed = { state: "err", why: "rejected the request" };
    else if (/facet field/.test(error))
      parts.facetsAllowed = { state: "err", why: "rejected the request" };
  }

  let src = RESOURCE;
  for (const key of Object.keys(parts)) {
    const start = src.indexOf(`⟦${key}|`);
    if (start < 0) continue;
    const lineStart = src.lastIndexOf("\n", start) + 1;
    const indent = src.slice(lineStart, start);
    const lineEnd = src.indexOf("\n", src.indexOf("⟧", start));
    src = `${src.slice(0, lineEnd)}\n${indent}__WHY_${key}__${src.slice(lineEnd)}`;
  }
  let html = hlMarked(src, "ts", "pg-part");
  for (const [key, { state, why }] of Object.entries(parts)) {
    html = html.replace(`data-p="${key}"`, `data-p="${key}" data-state="${state}"`);
    html = html.replace(
      new RegExp(`<span class="tk-\\w+">__WHY_${key}__</span>`),
      `<span class="pg-why" data-state="${state}">${state === "err" ? "✕" : "↑"} ${escapeHtml(why)}</span>`,
    );
  }
  return html;
}

export const SCHEMA = `export const orders = sqliteTable("orders", {
  id: text("id").primaryKey(),
  reference: text("reference").notNull(),
  status: text("status").notNull(),
  totalAmount: integer("total_amount").notNull(),
  createdAt: text("created_at").notNull(),
  customerId: text("customer_id").notNull(),
  deletedAt: text("deleted_at"),
});

export const customers = sqliteTable("customers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  orgId: text("org_id").notNull(),
});

export const orderLines = sqliteTable("order_lines", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull(),
  productId: text("product_id").notNull(),
  quantity: integer("quantity").notNull(),
});

export const products = sqliteTable("products", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  sku: text("sku").notNull(),
  category: text("category").notNull(),
});`;

/* ---------- display ---------- */
export const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
export const num = (n: number) => n.toLocaleString("en-US");
export const day = (iso: string) => iso.slice(0, 10);

export function conditionText(c: Condition): string {
  const v = c.value;
  if (Array.isArray(v)) return v.join(", ");
  if (v && typeof v === "object") {
    const { from, to } = v as { from?: unknown; to?: unknown };
    return `${from ?? "…"} and ${to ?? "…"}`;
  }
  return typeof v === "number" ? num(v) : String(v ?? "");
}

export function groupText(g: Group): string {
  return g.children
    .map((n) =>
      n.type === "group"
        ? `(${groupText(n)})`
        : `${n.key} ${OP_LABEL[n.operator] ?? n.operator} ${conditionText(n)}`,
    )
    .join(` ${g.combinator} `);
}
