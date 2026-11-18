import { onBeforeUnmount, onMounted } from "vue";

/* ---------- small helpers shared by the pixel landing ---------- */

export const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

export const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export const inView = (el: Element) => {
  const r = el.getBoundingClientRect();
  return r.bottom > 0 && r.top < window.innerHeight;
};

export function seeded(seed: number) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

export type Colors = Record<"rain" | "hit" | "ink" | "ink3" | "dot" | "warn", string>;

const COLOR_VARS: Record<keyof Colors, string> = {
  rain: "--px-rain",
  hit: "--px-hit",
  ink: "--ui-text-highlighted",
  ink3: "--ui-text-muted",
  dot: "--px-dot",
  warn: "--px-warn",
};

/** Canvas colours come from the theme tokens; re-read when the colour mode changes. */
export function readColors(): Colors {
  const cs = getComputedStyle(document.documentElement);
  const out = {} as Colors;
  for (const key of Object.keys(COLOR_VARS) as (keyof Colors)[]) {
    out[key] = cs.getPropertyValue(COLOR_VARS[key]).trim();
  }
  return out;
}

/** One shared requestAnimationFrame loop for every canvas on the page. */
const frameCallbacks = new Set<(t: number) => void>();
let frameId = 0;
function runFrame(t: number) {
  for (const cb of frameCallbacks) cb(t);
  frameId = frameCallbacks.size ? requestAnimationFrame(runFrame) : 0;
}
export function useFrame(cb: (t: number) => void) {
  onMounted(() => {
    frameCallbacks.add(cb);
    if (!frameId) frameId = requestAnimationFrame(runFrame);
  });
  onBeforeUnmount(() => frameCallbacks.delete(cb));
}

/** Calls `cb` with fresh colours on mount and whenever the `dark` class flips. */
export function useThemeColors(cb: (c: Colors) => void) {
  let obs: MutationObserver | undefined;
  onMounted(() => {
    cb(readColors());
    obs = new MutationObserver(() => cb(readColors()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  });
  onBeforeUnmount(() => obs?.disconnect());
}

/* ---------- the mark: a pixel drop, one row caught ---------- */

const DROP = [
  ".....#.....",
  "....###....",
  "...#####...",
  "..#######..",
  ".#########.",
  ".#########.",
  "###########",
  "###########",
  "###########",
  ".#########.",
  "..#######..",
  "....###....",
];
const CAUGHT_ROW = 8;

export interface Cell {
  x: number;
  y: number;
  acc: boolean;
}

export function markCells(): Cell[] {
  const out: Cell[] = [];
  DROP.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      if (ch === "#") out.push({ x: x + (y === CAUGHT_ROW ? 1 : 0), y, acc: y === CAUGHT_ROW });
    }),
  );
  return out;
}

/* ---------- sample data: 2,412 orders for one tenant ---------- */

export const STATUSES = ["shipped", "processing", "pending", "cancelled"] as const;
export const CATEGORIES = ["laptops", "audio", "networking", "storage", "accessories"] as const;
export type Status = (typeof STATUSES)[number];
export type Category = (typeof CATEGORIES)[number];

export interface Order {
  id: number;
  ref: string;
  status: Status;
  cat: Category;
  prod: string;
  cust: string;
  amt: number;
  day: number;
}

const PRODUCTS: Record<Category, [string, string]> = {
  laptops: ["Halden 14", "Fjord Pro 16"],
  audio: ["Cirrus Headphones", "Nimbus Speaker"],
  networking: ["Stratus Router", "Mist Switch 8"],
  storage: ["Cumulus SSD 2TB", "Vault NAS"],
  accessories: ["Drip Dock", "Gust Mouse"],
};
const CUSTOMERS = [
  "Halvorsen Freight",
  "Okapi Health",
  "Brightwater Labs",
  "Tanaka Robotics",
  "Quarry Lane Studio",
  "Nordvik Energy",
  "Pell Street Bank",
  "Marlow & Finch",
  "Cedar Ridge Clinic",
  "Osei Imports",
  "Lindqvist Dental",
  "Fairhaven Press",
];

function pickWeighted<T>(rnd: () => number, items: [T, number][]): T {
  let r = rnd();
  for (const [value, p] of items) {
    if ((r -= p) < 0) return value;
  }
  return items[items.length - 1]![0];
}

let ordersCache: Order[] | undefined;
export function sampleOrders(): Order[] {
  if (ordersCache) return ordersCache;
  const rnd = seeded(11);
  const out: Order[] = [];
  for (let i = 0; i < 2412; i++) {
    const cat = pickWeighted<Category>(rnd, [
      ["laptops", 0.31],
      ["audio", 0.24],
      ["networking", 0.19],
      ["storage", 0.15],
      ["accessories", 0.11],
    ]);
    out.push({
      id: i,
      ref: `ORD-${29999 - i * 4}`,
      status: pickWeighted<Status>(rnd, [
        ["shipped", 0.5],
        ["processing", 0.223],
        ["pending", 0.195],
        ["cancelled", 0.082],
      ]),
      cat,
      prod: PRODUCTS[cat][rnd() < 0.5 ? 0 : 1],
      cust: CUSTOMERS[Math.floor(rnd() * CUSTOMERS.length)]!,
      amt: Math.round(Math.exp(5.4 + rnd() * 3.4)),
      day: 10000 - i * 4,
    });
  }
  return (ordersCache = out);
}

export const dayString = (day: number) =>
  new Date(Date.UTC(2026, 10, 17) - (10000 - day) * 0.035 * 86400000).toISOString().slice(0, 10);

/* ---------- LED board: pixels rain in and morph between words or the mark ---------- */

interface Particle {
  x: number;
  y: number;
  tx: number;
  ty: number;
  vx: number;
  vy: number;
  acc: boolean;
  free: boolean;
  delay: number;
}

export class PixelBoard {
  cols = 0;
  width = 0;
  height = 0;
  cell: number;
  colors?: Colors;
  private ctx: CanvasRenderingContext2D;
  private particles: Particle[] = [];
  private grid?: HTMLCanvasElement;
  private target = "";
  private rnd = seeded(7);

  constructor(
    private canvas: HTMLCanvasElement,
    private rows: number,
    private baseCell: number,
  ) {
    this.ctx = canvas.getContext("2d")!;
    this.cell = baseCell;
  }

  setColors(c: Colors) {
    this.colors = c;
    this.grid = undefined;
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.parentElement?.clientWidth ?? 0;
    this.cell = w < 600 ? Math.max(5, Math.floor(this.baseCell * 0.62)) : this.baseCell;
    this.cols = Math.floor(w / this.cell);
    this.width = w;
    this.height = this.rows * this.cell;
    this.canvas.width = w * dpr;
    this.canvas.height = this.height * dpr;
    this.canvas.style.height = `${this.height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.grid = undefined;
    if (this.target) this.show(this.target, true);
  }

  private wordCells(word: string): Cell[] {
    const off = document.createElement("canvas");
    off.width = this.cols;
    off.height = this.rows;
    const g = off.getContext("2d")!;
    let size = Math.round(this.rows * 0.78);
    g.font = `800 ${size}px Geist, sans-serif`;
    const measured = g.measureText(word).width;
    if (measured > this.cols - 4) {
      size = Math.floor((size * (this.cols - 4)) / measured);
      g.font = `800 ${size}px Geist, sans-serif`;
    }
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = "#fff";
    g.fillText(word, this.cols / 2, this.rows / 2 + 1);
    const data = g.getImageData(0, 0, this.cols, this.rows).data;
    const out: Cell[] = [];
    for (let y = 0; y < this.rows; y++)
      for (let x = 0; x < this.cols; x++)
        if (data[(y * this.cols + x) * 4 + 3]! > 120) out.push({ x, y, acc: false });
    return out;
  }

  private markTargets(): Cell[] {
    const s = Math.max(1, Math.floor(this.rows / 13));
    const ox = Math.floor(this.cols / 2 - 6 * s);
    const oy = Math.floor((this.rows - 12 * s) / 2);
    const out: Cell[] = [];
    for (const c of markCells())
      for (let i = 0; i < s; i++)
        for (let j = 0; j < s; j++) {
          if (s > 2 && (i === s - 1 || j === s - 1)) continue;
          out.push({ x: ox + c.x * s + i, y: oy + c.y * s + j, acc: c.acc });
        }
    return out;
  }

  /** Morph to a word, or to the mark with "__mark". */
  show(target: string, instant = false) {
    this.target = target;
    if (this.cols < 4) return;
    const cells = target === "__mark" ? this.markTargets() : this.wordCells(target);
    for (let i = cells.length - 1; i > 0; i--) {
      const j = Math.floor(this.rnd() * (i + 1));
      [cells[i], cells[j]] = [cells[j]!, cells[i]!];
    }
    const n = Math.max(this.particles.length, cells.length);
    for (let i = 0; i < n; i++) {
      const t = cells[i];
      if (!t) {
        const p = this.particles[i]!;
        p.free = true;
        p.vy = 0.1 + this.rnd() * 0.3;
        continue;
      }
      if (i >= this.particles.length)
        this.particles.push({
          x: t.x + (this.rnd() - 0.5) * 6,
          y: -2 - this.rnd() * this.rows * 1.5,
          tx: 0,
          ty: 0,
          vx: 0,
          vy: 0,
          acc: false,
          free: false,
          delay: 0,
        });
      const p = this.particles[i]!;
      p.tx = t.x;
      p.ty = t.y;
      p.acc = t.acc;
      p.free = false;
      p.vx = 0;
      p.delay = instant ? 0 : Math.floor((t.x / this.cols) * 22 + this.rnd() * 8);
      if (instant) {
        p.x = t.x;
        p.y = t.y;
      }
    }
  }

  /** Every pixel falls as rain, then the current target re-forms. */
  burst() {
    for (const p of this.particles) {
      p.free = true;
      p.vy = -(0.2 + this.rnd() * 0.6);
      p.vx = (this.rnd() - 0.5) * 0.8;
    }
    const target = this.target;
    window.setTimeout(() => this.show(target), 1400);
  }

  private drawGrid() {
    const dpr = window.devicePixelRatio || 1;
    const off = document.createElement("canvas");
    off.width = this.width * dpr;
    off.height = this.height * dpr;
    const g = off.getContext("2d")!;
    g.scale(dpr, dpr);
    g.fillStyle = this.colors?.dot ?? "rgba(255,255,255,.07)";
    const s = this.cell - 2;
    for (let y = 0; y < this.rows; y++)
      for (let x = 0; x < this.cols; x++) g.fillRect(x * this.cell + 1, y * this.cell + 1, s, s);
    this.grid = off;
  }

  tick(now: number) {
    if (!this.width || !this.colors || !inView(this.canvas)) return;
    const c = this.ctx;
    const s = this.cell;
    c.clearRect(0, 0, this.width, this.height);
    if (!this.grid) this.drawGrid();
    c.drawImage(this.grid!, 0, 0, this.width, this.height);
    const mark = this.target === "__mark";
    this.particles = this.particles.filter((p) => {
      if (p.free) {
        p.vy += 0.03;
        p.y += p.vy;
        p.x += p.vx;
        if (p.y > this.rows + 3) return false;
        c.globalAlpha = 0.55;
        c.fillStyle = this.colors!.rain;
      } else {
        if (p.delay > 0) {
          p.delay--;
          if (p.y < 0) p.y += 0.4;
        } else {
          p.x += (p.tx - p.x) * 0.14;
          p.y += (p.ty - p.y) * 0.14;
        }
        const settled = Math.abs(p.tx - p.x) + Math.abs(p.ty - p.y) < 0.05;
        c.globalAlpha = settled ? 0.84 + 0.16 * Math.sin(now * 0.003 + p.tx * 0.7 + p.ty) : 0.9;
        c.fillStyle = mark && !p.acc ? this.colors!.ink : this.colors!.hit;
      }
      c.fillRect(Math.round(p.x * s) + 1, Math.round(p.y * s) + 1, s - 2, s - 2);
      return true;
    });
    c.globalAlpha = 1;
  }
}

/* ---------- syntax highlighting for hand-written snippets ---------- */

const TS_KEYWORDS = new Set(
  "export const let var type typeof await async return import from new interface extends keyof in of as".split(
    " ",
  ),
);
const LITERALS = new Set(["true", "false", "null", "undefined"]);
const SQL_KEYWORDS = new Set(
  "select from where and or join inner left lateral on order by desc asc limit group grouping sets as any in is not with".split(
    " ",
  ),
);
const SQL_FUNCTIONS = new Set(["count", "sum", "json_build_object"]);
const TOKEN =
  /(\/\/[^\n]*|--[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`[^`]*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)|([{}()[\];,.:=<>|?&*+\-/!]+)/g;

const escapeHtml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");

export type Lang = "ts" | "sql";

/** Tokenises TypeScript or SQL into spans with `tk-*` classes. */
export function hl(text: string, lang: Lang = "ts"): string {
  let out = "";
  let last = 0;
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(text); m; m = TOKEN.exec(text)) {
    out += escapeHtml(text.slice(last, m.index));
    last = TOKEN.lastIndex;
    const t = m[0];
    let cls = "tk-id";
    if (m[1]) cls = "tk-com";
    else if (m[2]) cls = lang === "sql" && t[0] === '"' ? "tk-col" : "tk-str";
    else if (m[3]) cls = "tk-num";
    else if (m[5]) cls = "tk-punc";
    else {
      const next = text.slice(last).match(/^\s*(.)/)?.[1] ?? "";
      const lower = t.toLowerCase();
      if (LITERALS.has(t)) cls = "tk-num";
      else if (lang === "sql" && SQL_FUNCTIONS.has(lower)) cls = "tk-fn";
      else if (lang === "sql" && SQL_KEYWORDS.has(lower)) cls = "tk-kw";
      else if (lang === "ts" && TS_KEYWORDS.has(t)) cls = "tk-kw";
      else if (next === "(") cls = "tk-fn";
      else if (next === ":" && lang === "ts") cls = "tk-prop";
      else if (/^[A-Z]/.test(t)) cls = "tk-type";
    }
    out += `<span class="${cls}">${escapeHtml(t)}</span>`;
  }
  return out + escapeHtml(text.slice(last));
}

/**
 * Like `hl`, plus marked regions: `⟦key|text⟧` becomes a span with `data-p="key"` and the given
 * class, so a part of a snippet can be lit up from outside.
 */
export function hlMarked(src: string, lang: Lang = "ts", cls = "px-part"): string {
  return src
    .split(/(⟦\w+\|[\s\S]*?⟧)/)
    .map((seg) => {
      const m = seg.match(/^⟦(\w+)\|([\s\S]*)⟧$/);
      return m ? `<span class="${cls}" data-p="${m[1]}">${hl(m[2]!, lang)}</span>` : hl(seg, lang);
    })
    .join("");
}
