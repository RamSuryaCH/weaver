# ADR 0003 — Verify the heal preview against the contract before approving

**Status:** accepted · 2026-08-18

## Context

`bdata scraper heal <id> "<what broke>"` stops at an approval gate and returns a
`preview_result` showing what the proposed fix would extract. The CLI also offers
`--auto-approve`, which skips the gate and commits the change.

For an unattended pipeline, `--auto-approve` is the only option on offer — and it
means an AI's proposed fix reaches production with nothing checking it. The failure
mode is not theoretical. A refactorer asked to make `mrp` return a number can
satisfy that by latching onto a static element, so every product reports ₹249. The
field is populated, the type is right, and the data is worthless.

## Decision

Weaver never passes `--auto-approve`. It stops at the gate, takes the
`preview_result`, and runs it through **the same contract that detected the
break**. Only if the preview satisfies the contract does it call
`bdata scraper approve`. Otherwise it calls `approve --reject`, which leaves the
collector exactly as it was, sharpens the prompt from the specific failure, and
tries again within a bounded budget.

A heal is trusted because the output satisfies the contract, not because an AI
produced it.

Two details make preview verification different from run verification, and getting
them wrong would make the gate useless:

- **Run-level expectations are ignored.** A preview is a sample, often a single
  row. Applying `min_rows` would fail every preview.
- **Only the fields the heal was asked to repair are judged.** A pre-existing
  problem elsewhere is not this fix's fault, and failing on it would loop until the
  budget ran out.

An approved fix then has to satisfy the contract on a **real re-run** before the
incident closes. Approval is Bright Data agreeing to the change; the re-run is
reality agreeing.

## Consequences

`packages/core/src/preview.ts` is pure and separately tested, including the case
above: a fix that returns the same value for every product is rejected with the
reason "extraction is still latched onto a fixed element", and that sentence goes
verbatim into the next prompt.

Healing is slower than `--auto-approve` — up to three round trips of five to
fifteen minutes each. That is the correct trade for a pipeline whose output is
medicine prices.

There is no bypass. The gate lives in `@weaver/engine`, so the CLI and the MCP
server both get it, and an agent cannot reach past it.
