# Agent Rules

## Commit Messages

- Use Conventional Commits for every commit.
- Always include a scope: `type(scope): subject`
- Do not create commits without a scope.
- Keep the subject short, imperative, and lowercase where natural.
- Do not end the subject with a period.

## Preferred Types

- `feat(scope): ...` for new user-facing features
- `fix(scope): ...` for bug fixes
- `docs(scope): ...` for documentation content or docs UX changes
- `refactor(scope): ...` for structural code changes without behavior changes
- `chore(scope): ...` for tooling, config, release, or maintenance work
- `ci(scope): ...` for workflow and CI changes
- `test(scope): ...` for tests only

## Scope Guidance

- Use package or domain scopes such as `core`, `docs`, `release`, `ci`, `monorepo`, `filters`, `twoslash`, or `landing`
- Prefer the narrowest scope that still makes the commit understandable
- Merge commits and release commits should also follow the same `type(scope): subject` format

## Examples

- `feat(filters): simplify top-level filter requests`
- `fix(docs): restore landing code block alignment`
- `docs(twoslash): add type-safety guide`
- `ci(release): skip publish workflow when no changeset exists`
- `refactor(monorepo): split packages behind a single published entrypoint`
