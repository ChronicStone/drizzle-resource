import type { QuerySorting } from "./types.js";

interface CursorPayload {
  v: 1;
  resource: string;
  sorting: Array<[key: string, dir: "asc" | "desc"]>;
  values: CursorValue[];
}

type CursorValue =
  | null
  | string
  | number
  | boolean
  | { type: "bigint"; value: string }
  | { type: "date"; value: string };

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): string {
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

function serializeValue(value: unknown): CursorValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return { type: "bigint", value: value.toString() };
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return { type: "date", value: value.toISOString() };
  }
  throw new Error("Cursor values must be database scalar values");
}

function deserializeValue(value: CursorValue): unknown {
  if (value && typeof value === "object") {
    if (value.type === "bigint") return BigInt(value.value);
    if (value.type === "date") {
      const date = new Date(value.value);
      if (!Number.isFinite(date.getTime())) throw new Error("Invalid cursor date");
      return date;
    }
  }
  return value;
}

function expectedSorting(sorting: QuerySorting): CursorPayload["sorting"] {
  return sorting.map(({ key, dir }) => [key, dir]);
}

function isCursorValue(value: unknown): value is CursorValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (record.type === "bigint" || record.type === "date") && typeof record.value === "string";
}

export function encodeCursor(resource: string, sorting: QuerySorting, values: unknown[]): string {
  if (values.length !== sorting.length) {
    throw new Error("Cursor value count does not match the effective sorting");
  }
  const payload: CursorPayload = {
    v: 1,
    resource,
    sorting: expectedSorting(sorting),
    values: values.map(serializeValue),
  };
  return encodeBase64Url(JSON.stringify(payload));
}

export function decodeCursor(cursor: string, resource: string, sorting: QuerySorting): unknown[] {
  try {
    const payload = JSON.parse(decodeBase64Url(cursor)) as Partial<CursorPayload>;
    const sortingMatches =
      JSON.stringify(payload.sorting) === JSON.stringify(expectedSorting(sorting));
    if (
      payload.v !== 1 ||
      payload.resource !== resource ||
      !sortingMatches ||
      !Array.isArray(payload.values) ||
      payload.values.length !== sorting.length ||
      !payload.values.every(isCursorValue)
    ) {
      throw new Error("Cursor payload does not match this query");
    }
    return payload.values.map(deserializeValue);
  } catch {
    throw new Error("Invalid cursor");
  }
}
