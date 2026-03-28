# Changesets

Use Changesets to manage releases and generate changelog entries.

## Create a release note

```sh
bun run changeset
```

## Cut a version locally

```sh
bun run release:version
```

## Publish

```sh
bun run release:publish
```

In normal operation, publishing should happen from GitHub Actions after a changeset release PR is merged.
