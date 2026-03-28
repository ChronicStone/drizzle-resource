import type { QueryWith } from "drizzle-resource";

import type { schema } from "./schema";

type OrdersWith = QueryWith<
  {
    query: {
      orders: {
        findMany: (args?: {
          with?: {
            customer?: true;
            orderLines?: {
              with?: {
                product?: true;
              };
            };
          };
        }) => Promise<
          Array<{
            createdAt: string;
            customer: { id: string; name: string; orgId: string };
            deletedAt: string | null;
            id: string;
            orderLines: Array<{
              id: string;
              product: {
                category: string;
                id: string;
                label: string;
                name: string;
                sku: string;
              };
              quantity: number;
            }>;
            reference: string;
            status: string;
            totalAmount: number;
          }>
        >;
      };
    };
  },
  typeof schema,
  "orders"
>;

export const db = {
  query: {
    orders: {
      findMany: async (_args?: { with?: OrdersWith }) => [
        {
          createdAt: "2026-01-01T00:00:00.000Z",
          customer: {
            id: "customer_1",
            name: "Acme Corp",
            orgId: "acme",
          },
          deletedAt: null,
          id: "order_1",
          orderLines: [
            {
              id: "line_1",
              product: {
                category: "electronics",
                id: "product_1",
                label: "Electronics",
                name: "Laptop Pro",
                sku: "LAPTOP-PRO",
              },
              quantity: 2,
            },
          ],
          reference: "ORD-001",
          status: "pending",
          totalAmount: 1200,
        },
      ],
    },
  },
};
