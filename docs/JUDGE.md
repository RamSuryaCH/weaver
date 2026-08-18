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

## Scraper types

Three of Scraper Studio's five types, all against the same three sites, all added
as YAML contracts with no code changes — which is the point: the contract engine is
type-agnostic because every type returns rows, and rows are judged identically.

| Type          | Collector                                                            | What it does                                            |
| ------------- | -------------------------------------------------------------------- | ------------------------------------------------------- |
| **PDP** ×3    | `c_msz4j3yo230n7kzhbe`, `c_msz4k0rsm4wpfezt3`, `c_msz4k329ghj4p6o3y` | one product page → one priced row                       |
| **Discovery** | `c_msz6cw2l2bmrq68lqf`                                               | a drug-salt listing page → every brand of that molecule |
| **Sitemap**   | `sources/dawaadost-sitemap.yaml`                                     | the published sitemap → product URLs, no crawling       |

Discovery is what makes the pipeline self-feeding:
`/drug-salts/pantoprazole-72` lists every pantoprazole brand Truemeds stocks, so
Discovery finds the products and the PDP collectors price them, with nobody
maintaining a URL list by hand.

**Search was deliberately not built, and this is the interesting one.** Truemeds
disallows `/search` in robots.txt and Apollo disallows `/search/` and
`/medicine/search-medicines/`. Dawaa Dost permits it, but its search results are
rendered client-side — the HTML contains zero product links. So the options were to
violate a robots.txt directive or to ship a collector that returns nothing. Neither
is worth a checkbox, and the contract engine already accepts `type: search` with
`inputs.keywords`, so adding one against a permitting site is a config change
rather than a code change.

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
| **Technical excellence**       | `pnpm verify` — format, lint, typecheck (including the dashboard) and 263 tests. `any` is a lint error. Every boundary is parsed with zod. Four ADRs in `docs/adr/`.                   |
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

- **Search is not implemented**, deliberately. See the scraper-types section above:
  two of three sites disallow search paths in robots.txt, and the third renders
  results client-side.
- **Generation timed out once, and left a half-built collector.** Pointing
  `bdata scraper create` at an 8 MB sitemap with 20,000 URLs hung Scraper Studio's
  schema generator past the CLI's 600-second ceiling. `c_msz6cyqz8au5eg07j` is that
  dead collector; Bright Data exposes no programmatic deletion, so it is noted here
  rather than quietly removed. A 684 KB sitemap generates fine.
- **Pack size is inferred, not read.** Until a heal adds a `pack_size` field to all
  three collectors, pack size is parsed from the product name. The dashboard marks
  inferred values with a `?` rather than presenting a guess as a fact.
- **Apollo Pharmacy's collector is the weakest of the three.** Its product pages
  render more content client-side, and the generated scraper reflects that. Its
  incident is real and open.
- **One heal was approved and then failed verification.** Dawaa Dost's
  `composition` fix satisfied the contract on a one-row preview, was approved, and
  still returned 2 of 15 on the real re-run. Weaver escalated rather than declaring
  success. That is the system working, and it is also an open problem.
- **A cross-field invariant is missing.** Truemeds returned a `selling_price` of
  ₹7,531.25 against an MRP of ₹93.75 — eighty times the printed price, and it passed
  every rule, because `lt: 100000` is a range check and nothing expresses
  `selling_price <= mrp`. The contract language needs cross-field rules.
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
