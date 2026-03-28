import type {
  QueryFilterBuilder,
  QueryFilterCondition,
  QueryFilterGroup,
  QueryFilterNode,
} from './types.js'

function group<TField extends string>(
  combinator: 'and' | 'or',
  children: QueryFilterNode<TField>[],
): QueryFilterGroup<TField> {
  return {
    type: 'group',
    combinator,
    children,
  }
}

function condition<TField extends string>(
  key: TField,
  operator: QueryFilterCondition<TField>['operator'],
  value: unknown,
): QueryFilterCondition<TField> {
  return {
    type: 'condition',
    key,
    operator,
    value,
  }
}

/**
 * Create a small typed DSL for building `QueryFilterNode` trees.
 *
 * This is mainly useful inside `query.scope(filters, context)` handlers and tests:
 *
 * ```ts
 * const filters = createQueryFilterBuilder<'status' | 'createdAt'>()
 *
 * filters.and([
 *   filters.is('status', 'active'),
 *   filters.between('createdAt', { from: '2026-01-01', to: '2026-01-31' }),
 * ])
 * ```
 */
export function createQueryFilterBuilder<TField extends string>(): QueryFilterBuilder<TField> {
  return {
    condition: (input) => input,
    and: (children) => group('and', children),
    or: (children) => group('or', children),
    contains: (key, value) => condition(key, 'contains', value),
    is: (key, value) => condition(key, 'is', value),
    isAnyOf: (key, value) => condition(key, 'isAnyOf', value),
    isNot: (key, value) => condition(key, 'isNot', value),
    gt: (key, value) => condition(key, 'gt', value),
    gte: (key, value) => condition(key, 'gte', value),
    lt: (key, value) => condition(key, 'lt', value),
    lte: (key, value) => condition(key, 'lte', value),
    between: (key, value) => condition(key, 'between', value),
    before: (key, value) => condition(key, 'before', value),
    after: (key, value) => condition(key, 'after', value),
  }
}
