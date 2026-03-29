import Database from "better-sqlite3";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

const PLAYGROUND_PRODUCT_COUNT = 180;
const PLAYGROUND_CUSTOMER_COUNT = 320;
const PLAYGROUND_ORDER_COUNT = 10000;

const PRODUCT_CATEGORIES = ["audio", "accessories", "laptops", "monitors", "networking", "storage"];

function mulberry32(seed) {
  let current = seed >>> 0;

  return () => {
    current += 0x6d2b79f5;
    let value = Math.imul(current ^ (current >>> 15), 1 | current);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInt(random, min, max) {
  return Math.floor(random() * (max - min + 1)) + min;
}

function randomPick(random, values) {
  return values[randomInt(random, 0, values.length - 1)];
}

function randomUpper(random, length) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let value = "";

  for (let index = 0; index < length; index += 1) {
    value += alphabet[randomInt(random, 0, alphabet.length - 1)];
  }

  return value;
}

function randomCompanyName(random, index) {
  const prefixes = [
    "Acme",
    "Northstar",
    "Vertex",
    "Atlas",
    "Summit",
    "Bluebird",
    "Harbor",
    "Cinder",
  ];
  const middles = [
    "Systems",
    "Labs",
    "Works",
    "Commerce",
    "Logistics",
    "Industries",
    "Supply",
    "Dynamics",
  ];
  const suffixes = ["Group", "Co", "HQ", "Collective", "Partners"];

  return `${randomPick(random, prefixes)} ${randomPick(random, middles)} ${randomPick(random, suffixes)} ${index + 1}`;
}

function randomProductName(random) {
  const adjectives = [
    "Adaptive",
    "Precision",
    "Modular",
    "Compact",
    "Wireless",
    "Industrial",
    "Portable",
    "Ultra",
  ];
  const materials = ["Carbon", "Aluminum", "Fiber", "Steel", "Ceramic", "Composite", "Graphite"];
  const nouns = ["Hub", "Laptop", "Headset", "Dock", "Monitor", "Router", "Array", "Keyboard"];

  return `${randomPick(random, adjectives)} ${randomPick(random, materials)} ${randomPick(random, nouns)}`;
}

function sampleMany(random, values, count) {
  const copy = [...values];

  for (let index = copy.length - 1; index > 0; index -= 1) {
    const nextIndex = randomInt(random, 0, index);
    [copy[index], copy[nextIndex]] = [copy[nextIndex], copy[index]];
  }

  return copy.slice(0, count);
}

function createCustomers() {
  const random = mulberry32(20260328);

  return Array.from({ length: PLAYGROUND_CUSTOMER_COUNT }, (_, index) => ({
    id: `customer_${index + 1}`,
    name: randomCompanyName(random, index),
    orgId: index < Math.floor(PLAYGROUND_CUSTOMER_COUNT * 0.74) ? "acme" : "globex",
  }));
}

function createProducts() {
  const random = mulberry32(20260329);

  return Array.from({ length: PLAYGROUND_PRODUCT_COUNT }, (_, index) => {
    const category = randomPick(random, PRODUCT_CATEGORIES);

    return {
      category,
      id: `product_${index + 1}`,
      label: category.charAt(0).toUpperCase() + category.slice(1),
      name: randomProductName(random),
      price: randomInt(random, 45, 2800),
      sku: randomUpper(random, 10),
    };
  });
}

function createPlaygroundDb(filePath) {
  rmSync(filePath, { force: true });
  mkdirSync(dirname(filePath), { recursive: true });

  const db = new Database(filePath);

  db.exec(`
    pragma journal_mode = delete;
    create table customers (id text primary key, name text not null, org_id text not null);
    create table products (id text primary key, category text not null, label text not null, name text not null, sku text not null);
    create table orders (id text primary key, created_at text not null, customer_id text not null, deleted_at text, reference text not null, status text not null, total_amount integer not null);
    create table order_lines (id text primary key, order_id text not null, product_id text not null, quantity integer not null);
    create index idx_customers_org_id_lower on customers(lower(org_id));
    create index idx_customers_name_lower on customers(lower(name));
    create index idx_orders_customer_id on orders(customer_id);
    create index idx_orders_created_at on orders(created_at);
    create index idx_orders_status_lower on orders(lower(status));
    create index idx_orders_reference_lower on orders(lower(reference));
    create index idx_order_lines_order_id on order_lines(order_id);
    create index idx_order_lines_product_id on order_lines(product_id);
    create index idx_products_category_lower on products(lower(category));
    create index idx_products_name_lower on products(lower(name));
    create index idx_products_sku_lower on products(lower(sku));
  `);

  const customers = createCustomers();
  const products = createProducts();
  const random = mulberry32(20260330);
  const start = new Date("2025-01-01T00:00:00.000Z").getTime();
  const end = new Date("2026-03-20T00:00:00.000Z").getTime();

  const insertCustomer = db.prepare("insert into customers (id, name, org_id) values (?, ?, ?)");
  const insertProduct = db.prepare(
    "insert into products (id, category, label, name, sku) values (?, ?, ?, ?, ?)",
  );
  const insertOrder = db.prepare(
    "insert into orders (id, created_at, customer_id, deleted_at, reference, status, total_amount) values (?, ?, ?, ?, ?, ?, ?)",
  );
  const insertOrderLine = db.prepare(
    "insert into order_lines (id, order_id, product_id, quantity) values (?, ?, ?, ?)",
  );
  const updateOrderTotal = db.prepare("update orders set total_amount = ? where id = ?");

  const weightedStatuses = [
    "pending",
    "pending",
    "pending",
    "processing",
    "processing",
    "processing",
    "shipped",
    "shipped",
    "shipped",
    "shipped",
    "shipped",
    "shipped",
    "cancelled",
  ];

  const transaction = db.transaction(() => {
    for (const customer of customers) {
      insertCustomer.run(customer.id, customer.name, customer.orgId);
    }

    for (const product of products) {
      insertProduct.run(product.id, product.category, product.label, product.name, product.sku);
    }

    for (let orderIndex = 0; orderIndex < PLAYGROUND_ORDER_COUNT; orderIndex += 1) {
      const customer = randomPick(random, customers);
      const createdAt = new Date(randomInt(random, start, end)).toISOString();
      const status = randomPick(random, weightedStatuses);
      const deletedAt =
        status === "cancelled" && randomInt(random, 1, 100) <= 16
          ? new Date(
              new Date(createdAt).getTime() + randomInt(random, 1, 12) * 86400000,
            ).toISOString()
          : null;
      const lineCount = randomInt(random, 1, 5);
      const selectedProducts = sampleMany(random, products, lineCount);
      let totalAmount = 0;

      insertOrder.run(
        `order_${orderIndex + 1}`,
        createdAt,
        customer.id,
        deletedAt,
        `ORD-${String(orderIndex + 1).padStart(5, "0")}`,
        status,
        0,
      );

      selectedProducts.forEach((product, productIndex) => {
        const quantity = randomInt(random, 1, 4);
        totalAmount += product.price * quantity;
        insertOrderLine.run(
          `line_${orderIndex + 1}_${productIndex + 1}`,
          `order_${orderIndex + 1}`,
          product.id,
          quantity,
        );
      });

      updateOrderTotal.run(totalAmount, `order_${orderIndex + 1}`);
    }
  });

  transaction();
  db.close();
}

const outputFile = resolve(import.meta.dirname, "../app/assets/playground.sqlite");
createPlaygroundDb(outputFile);
console.log(`Generated ${outputFile}`);
