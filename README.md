# drizzle-resource

Schema-driven query resources for Drizzle ORM. One typed contract for filtering, sorting, search, pagination, hydration, and facets.

```sh
npm install drizzle-resource
```

## Usage

```ts
import { createQueryEngine } from 'drizzle-resource'

const engine = createQueryEngine({ db, schema, relations })
  .withContext<{ orgId: string }>()

export const ordersResource = engine.defineResource('orders', {
  relations: {
    customer: true,
    orderLines: { with: { product: true } },
  },
  query: {
    scope: engine.defineScope('orders', { customer: true }, (ctx, f) =>
      f.is('customer.orgId', ctx.orgId)
    ),
    search: {
      allowed: ['reference', 'customer.name', 'orderLines.product.name'],
      defaults: ['reference', 'customer.name'],
    },
    sort: { defaults: [{ key: 'createdAt', dir: 'desc' }] },
    facets: { allowed: ['status', 'customer.name'] },
    defaults: { pagination: { pageSize: 25 } },
  },
})

const result = await ordersResource.query({
  context: { orgId: 'acme' },
  request: {
    pagination: { pageIndex: 1, pageSize: 25 },
    sorting: [{ key: 'createdAt', dir: 'desc' }],
    search: { value: 'laptop', fields: [] },
    filters: { type: 'group', combinator: 'and', children: [] },
    facets: [{ key: 'status', mode: 'exclude-self', limit: 10 }],
  },
})
// result: { rows, rowCount, facets }
```

## Docs

→ [drizzle-resource.vercel.app](https://drizzle-resource.vercel.app)

## License

MIT
