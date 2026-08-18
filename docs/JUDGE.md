# For the judges

A map from each judging criterion to the exact file, command or artifact that
satisfies it. Everything below can be checked from a fresh clone in about a
minute, and nothing in this document requires a Bright Data account.

```bash
pnpm install
pnpm weaver doctor        # environment, CLI reachability, every contract
pnpm weaver check --explain   # the verdict on the last recorded run of each source
pnpm dev                  # the dashboard at http://localhost:4321
```

Weaver defaults to `WEAVER_MODE=replay`, which reads the committed runs in
`fixtures/` instead of triggering collectors. Cloning is therefore enough to
explore the whole product, including a real incident, without spending a credit.

## The Collector IDs

Real, live, and pinned in the contracts. Healing keeps them stable, so these are
the same before and after every repair in this repo.

| Source          | Collector ID           | Contract                       |
| --------------- | ---------------------- | ------------------------------ |
| Truemeds        | `c_msz4j3yo230n7kzhbe` | `sources/truemeds.yaml`        |
| Dawaa Dost      | `c_msz4k0rsm4wpfezt3`  | `sources/dawaadost.yaml`       |
| Apollo Pharmacy | `c_msz4k329ghj4p6o3y`  | `sources/apollo-pharmacy.yaml` |

## The grand-prize criterion, part by part

> "the scraper you designed in Scraper Studio, how you drove it from your coding
> agent, what it did when the site changed under it, and what the structured
> output went on to power."

### The scraper you designed

Three custom Scraper Studio scrapers over three Indian online pharmacies, created
with `bdata scraper create` from the `description` field of each contract — the same
sentence that then validates every run.

- `sources/*.yaml` — the contracts, one per site, 8 fields each
- `docs/targets.md` — why these three sites are long tail, the robots.txt evidence,
  and why `medplusmart.com` was dropped rather than worked around
- `fixtures/` — the actual JSON each collector returned

### How you drove it from your coding agent

Weaver ships **its own MCP server**, so the entire reliability loop runs from a
chat prompt with no dashboard open.

- `packages/mcp/src/server.ts` — five tools: `weaver_list_sources`,
  `weaver_collect`, `weaver_diagnose`, `weaver_heal`, `weaver_compare_prices`
- `packages/mcp/src/server.test.ts` — 15 tests driven through a **real MCP client**
  over an in-memory transport, so the tool names, schemas and annotations are what
  is covered, not the functions behind them
- `docs/agent-integration.md` — both MCP servers and the three guard rails
- `CLAUDE.md`, `CODEX.md`, `.cursor/rules/weaver.mdc`, `.mcp.json` — pinned
  Collector IDs, as Bright Data recommends, so an agent reuses the scrapers

Three guard rails are structural, not advisory:

1. `weaver_heal` requires `confirm: true` — a required field in the tool's input
   schema, so an agent cannot omit it
2. it refuses under a `manual` heal policy, and says which setting to change
3. the verify-then-approve gate lives in the engine, so there is no code path an
   agent could use to skip it

### What it did when the site changed under it

All three collectors were **defective on their first live run**, in three different
ways, and Weaver caught all three against the contract:

| Source          | What the contract caught                                                |
| --------------- | ----------------------------------------------------------------------- |
| Truemeds        | `selling_price` of ₹300,107.50 on a product whose MRP is ₹375           |
| Dawaa Dost      | `composition` present on 13% of rows against a floor of 80%             |
| Apollo Pharmacy | `product_name` on 60%, and `mrp`, `selling_price`, `composition` on 27% |

These are real defects in AI-generated scrapers, found by the contract rather than
by reading the data. The repairs in `docs/transcripts/` and in the dashboard's
incident timeline are repairs of those defects.

- `packages/core/src/drift.ts` — the detection engine
- `packages/core/src/preview.ts` — the gate: a preview is verified against the same
  contract that detected the break, before approval
- `packages/engine/src/heal.ts` — the loop, with prompt sharpening and escalation
- `docs/adr/0003-verify-then-approve.md` — why `--auto-approve` is never used

### What the structured output powers

Medicine price transparency across the three pharmacies, normalised to price per
unit.

- `/prices` in the dashboard, and `GET /api/v1/prices`
- `packages/core/src/catalogue.ts` — composition matching and per-unit
  normalisation
- The finding worth reading: the pharmacy showing the **lowest price on the page**
  can be the **most expensive per tablet**, because pack sizes differ (10 vs 15).
  Comparing pack prices would recommend the dearest option with total confidence.

## The six judging criteria

| Criterion                      | Where to look                                                                                                                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Potential impact**           | `/prices` — same molecule, three pharmacies, per-unit prices. Wrong medicine prices have consequences, which is why the contract has range rules at all.                               |
| **Creativity / innovation**    | Two ideas: one plain-language description used to create, validate **and** repair a field; and verify-then-approve, where a heal is trusted because the output satisfies the contract. |
| **Technical excellence**       | `pnpm verify` — format, lint, typecheck (including the dashboard) and 258 tests. `any` is a lint error. Every boundary is parsed with zod. Four ADRs in `docs/adr/`.                   |
| **Use of Scraper Studio**      | Three real `c_*` collectors, created and healed through the CLI, triggered through `POST /dca/trigger`. Nothing in this project works without them.                                    |
| **Reliability / self-healing** | `packages/engine/src/heal.ts` and its 13 tests; the chaos harness's 8 mutations, each with a test proving it triggers the finding it simulates; the incident timeline.                 |
| **Presentation**               | The dashboard, the demo video, and `weaver` itself — the terminal output is designed, not debug spew.                                                                                  |

## Things worth trying

```bash
# Break a source on purpose and watch detection catch it.
# The quiet failure: 100% fill rate, and every row identical.
pnpm weaver chaos --source truemeds --mutation constant-field --field selling_price --explain

# See the prompt Weaver would send, without spending anything.
pnpm weaver heal --source truemeds --dry-run

# Every mutation, proven to trigger the finding it simulates.
pnpm vitest run packages/core/src/chaos.test.ts

# The gate rejecting a bad fix, then succeeding on a sharpened prompt.
pnpm vitest run packages/engine/src/heal.test.ts
```

## Honest limitations

- **Pack size is inferred, not read.** Until the heal that adds a `pack_size`
  field lands on all three collectors, pack size is parsed from the product name.
  The dashboard marks inferred values with a `?` rather than presenting a guess as
  a fact.
- **Apollo Pharmacy's collector is the weakest of the three.** Its product pages
  render more of the content client-side, and the generated scraper reflects that.
  Its incident is real and open.
- **The baseline needs three healthy runs** before drift comparisons switch on.
  Contract checks apply from the first run, so a new source is never unguarded, but
  "drifted from normal" needs a normal to exist first.
- **`bdata budget balance` returns 403** with the token used here, which lacks the
  admin scope. Credit spend is therefore not shown in the dashboard.

## AI assistance disclosure

Built with AI coding assistance (Kiro, running Claude). The architecture, the
target selection, every design decision recorded in `docs/adr/`, and every
dependency choice were made and reviewed by the author, who can explain any part of
the system. Generated code was read before it was committed.
