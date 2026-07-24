# Contributing

Thanks for considering a contribution to Corbits Tag.

## Running it locally

```bash
git clone https://github.com/corbitsdev/corbits-tag.git
cd corbits-tag
bun install
```

Requires Bun 1.2+. See `README.md` for the mount snippet and
`IMPLEMENTATION.md` for how the pieces fit together.

## Running the tests

```bash
bun run typecheck && bun run test
```

- `bun run test` runs the unit suite (`bun test ./packages`) — handler wiring
  and the mount surface have colocated `*.test.ts` files. It needs no
  external services and no Slack workspace.
- `bun run test:coverage` runs the same suite with lcov + text coverage.

Both must pass before a PR is reviewed.

## Ground rules

- The mount contract is sacred: mount onto a host app, verify transport
  signatures, authenticate nothing else. Anything that smells like session
  auth or identity mapping belongs to the host.
- `@corbits/tag-core` stays dependency-free and platform-free. If a type
  mentions Slack, it doesn't belong there.
- Every exported function carries a doc comment that states its contract
  (doc-comments-as-spec).
- New platform adapters implement the `TagDispatch`/`TagEvent`/`TagThread`
  contract — don't fork the core types per platform.

## CLA

Contributions require agreeing to `CLA.md`.
