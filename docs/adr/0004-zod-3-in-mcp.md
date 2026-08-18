# ADR 0004 — `packages/mcp` pins zod 3 while everything else uses zod 4

**Status:** accepted · 2026-08-18

## Context

Weaver validates every boundary with zod, on version 4.1.13 throughout.

`@modelcontextprotocol/sdk` 1.22.0 declares `zod@^3.23.8` and its
`registerTool` signature is typed against zod 3's `ZodType<any, any, any>`. Passing
zod 4 schemas produces a wall of structural type errors: zod 4 rewrote the internal
shape that signature names.

## Decision

`packages/mcp` depends on `zod@3.25.76`. Every other package stays on `zod@4.1.13`.
pnpm's isolated `node_modules` means the two coexist without interference.

## Consequences

This looks like a mistake in a `package.json` diff, which is the reason this ADR
exists.

The blast radius is one package. Tool input schemas are the only zod usage in
`packages/mcp`; domain types come from `@weaver/core`, which is version-agnostic at
the type level because it exports inferred TypeScript types rather than schemas.

The alternatives were worse. Downgrading the whole repo to zod 3 would give up
`z.url()` and the improved error format for the sake of one dependency. Importing
`zod/v3` from the zod 4 package works at runtime but not at the type level, because
the SDK resolves its own copy and type identity would still not match.

When the SDK ships zod 4 support, delete the pin and this ADR.
