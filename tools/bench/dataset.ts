import type { Client } from "pg";

const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;

/**
 * 20,000 customers and `rows` orders, with the indexes a project has before anyone tunes it: the
 * primary keys, the sort on `createdAt`, the foreign key, and trigram indexes on the two search
 * columns. `denormalized` adds `orders."customerName"`, copied from the customer, with no index:
 * `checkIndexes` asks for that one.
 */
export async function createBase(
  client: Client,
  schema: string,
  rows: number,
  denormalized = false,
) {
  const s = ident(schema);
  await client.query(`drop schema if exists ${s} cascade`);
  await client.query(`create schema ${s}`);
  await client.query("create extension if not exists pg_trgm");
  await client.query(
    `create table ${s}.customers (id integer primary key, name text not null, segment text not null)`,
  );
  await client.query(`create table ${s}.orders (
    id integer primary key, "customerId" integer not null, "orgId" integer not null,
    status text not null, paid boolean not null, "createdAt" timestamptz not null, reference text not null
    ${denormalized ? ', "customerName" text' : ""})`);
  await client.query(
    `insert into ${s}.customers select n, 'Customer ' || n, 'Segment ' || (n % 4) from generate_series(1, 20000) n`,
  );
  // createdAt is spread evenly over seven years ending on 2026-11-01, in step with id.
  await client.query(
    `insert into ${s}.orders
     select n, (n % 20000) + 1, (n % 100) + 1,
       (array['pending','paid','shipped','delivered','cancelled'])[(n % 5) + 1], n % 2 = 0,
       date_trunc('milliseconds', (timestamptz '2026-11-01 00:00:00+00' - interval '7 years')
         + ((timestamptz '2026-11-01 00:00:00+00') - (timestamptz '2026-11-01 00:00:00+00' - interval '7 years'))
           * ((n - 1)::double precision / $1::double precision)),
       'ORD-' || lpad(n::text, 8, '0')
       ${denormalized ? ", c.name" : ""}
     from generate_series(1, $1::integer) n
     ${denormalized ? `join ${s}.customers c on c.id = (n % 20000) + 1` : ""}`,
    [rows],
  );
  await client.query(`create index on ${s}.orders ("createdAt", id)`);
  await client.query(`create index on ${s}.orders ("customerId")`);
  await client.query(`create index on ${s}.orders using gin (lower(reference) gin_trgm_ops)`);
  await client.query(`create index on ${s}.customers using gin (lower(name) gin_trgm_ops)`);
  await analyze(client, schema);
}

export async function analyze(client: Client, schema: string) {
  const s = ident(schema);
  await client.query(`vacuum analyze ${s}.orders`);
  await client.query(`vacuum analyze ${s}.customers`);
}

export async function dropSchema(client: Client, schema: string) {
  await client.query(`drop schema if exists ${ident(schema)} cascade`);
}
