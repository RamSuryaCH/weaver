# Weaver

A self-healing web data control plane, built on Bright Data Scraper Studio.

Scrapers do not fail loudly. A class name changes, a field starts returning `null`,
and everything downstream keeps running on quietly degrading data. Bright Data
solved the repair primitive — `bdata scraper heal` fixes a scraper from a
plain-language prompt and keeps the same Collector ID, so nothing downstream
breaks. Weaver supplies the judgement around it: when to heal, what to say in the
prompt, and whether the repair actually worked.

It runs on a live medicine price transparency pipeline across three Indian online
pharmacies, where wrong data has consequences.

```
Truemeds        c_msz4j3yo230n7kzhbe
Dawaa Dost      c_msz4k0rsm4wpfezt3
Apollo Pharmacy c_msz4k329ghj4p6o3y
```

## What happened on the first live run

All three AI-generated scrapers were defective, in three different ways, and the
contract caught all three before a human looked at the data.

| Source          | What the contract caught                                                |
| --------------- | ----------------------------------------------------------------------- |
| Truemeds        | `selling_price` of ₹300,107.50 on a product whose MRP is ₹375           |
| Dawaa Dost      | `composition` on 13% of rows, against a floor of 80%                    |
| Apollo Pharmacy | `product_name` on 60%, and `mrp`, `selling_price`, `composition` on 27% |

None of these would have raised an alarm anywhere else. Every run returned 15 rows,
nothing threw, and no HTTP status was anything but 200. The price comparison built
on top of them was simply empty, because a field nobody was checking came back
`null`.

## The two ideas worth stealing

**1. One plain-language description, used three times.** Every field in
`sources/*.yaml` carries a sentence describing what it is. That same sentence
creates the scraper, validates every run, and repairs the scraper when it breaks.
The contract that built the scraper is the contract that fixes it.

```yaml
- field: mrp
  description: >-
    the printed maximum retail price in rupees, before any discount is applied
  type: number
  required: true
  validate: { gt: 0, lt: 100000 }
  drift: { median_shift_pct: 30, flag_constant: true }
```

**2. Verify-then-approve.** `bdata scraper heal --auto-approve` trusts the AI
blindly. Weaver takes the `preview_result` returned at the approval gate, runs it
back through the same contract that detected the break, and only then approves. If
the preview fails, it rejects the fix — leaving the collector untouched — sharpens
the prompt from the specific failure, and tries again within a bounded budget
before escalating to a GitHub issue.

A heal is trusted because the output satisfies the contract, not because an AI
produced it. This is not theoretical: an AI asked to make `mrp` return a number can
satisfy that by latching onto a static element, so every product reports ₹249. The
field is populated, the type is right, the data is worthless, and the gate rejects
it with _"extraction is still latched onto a fixed element"_ — a sentence that then
goes into the next prompt.

## Quickstart

Requires Node 22+ and pnpm 10+. No Bright Data account needed.

```bash
pnpm install
pnpm weaver doctor         # environment, CLI reachability, every contract
pnpm weaver check --explain    # the verdict on the last run of each source
pnpm dev                   # the dashboard at http://localhost:4321
```

Weaver defaults to `WEAVER_MODE=replay`, which reads the recorded runs committed in
`fixtures/` instead of triggering collectors. Cloning is enough to explore the whole
product, including a real incident, without spending a credit.

To run against live collectors, copy `.env.example` to `.env` and set
`BRIGHTDATA_API_KEY` (from <https://brightdata.com/cp/setting>).

### Break something on purpose

```bash
# The quiet failure: 100% fill rate, and every row carrying the same value.
pnpm weaver chaos --source truemeds --mutation constant-field --field selling_price --explain

# See the prompt Weaver would send. Spends nothing.
pnpm weaver heal --source truemeds --dry-run
```

## Driven from a coding agent

Weaver ships its own MCP server, so the whole loop runs from a chat prompt with no
dashboard open — which is what Bright Data's "the terminal is the UI" guidance
actually asks for.

| Tool                    | Read-only | Does                                                 |
| ----------------------- | --------- | ---------------------------------------------------- |
| `weaver_list_sources`   | yes       | every source, its Collector ID, its last verdict     |
| `weaver_collect`        | no        | trigger a collector, or replay a recorded run        |
| `weaver_diagnose`       | yes       | the violations, and the heal prompt it would send    |
| `weaver_heal`           | no        | the verify-then-approve loop; needs `confirm: true`  |
| `weaver_compare_prices` | yes       | same molecule across pharmacies, normalised per unit |

A recorded session is in `docs/transcripts/mcp-session.md`. Setup is in
`docs/agent-integration.md`.

## The product

Medicine prices across the three pharmacies, grouped by composition rather than
brand and normalised to price per unit — because the pharmacies sell the same
molecules in different pack sizes, and comparing the price on the page gives a
confidently wrong answer. In the committed data, the pharmacy showing the _lowest
price on the page_ is the _most expensive per tablet_.

`/prices` in the dashboard, or `GET /api/v1/prices`. `GET /api/v1/health` answers
503 when a source is violating its contract, so a scheduler cannot mistake a
degraded pipeline for a healthy one.

## Layout

```
packages/core        pure domain: contracts, drift, heal prompts, preview gate, catalogue. No I/O.
packages/config      loads sources/*.yaml and the environment. The only config reader.
packages/brightdata  typed Collection API client and bdata CLI adapter.
packages/db          SQLite store: runs, field statistics, findings, incidents.
packages/engine      orchestration: collect, and the verify-then-approve heal loop.
packages/mcp         the Weaver MCP server.
apps/cli             the weaver command line. The primary interface.
apps/web             the dashboard. A read-only view over the same database.
sources/             one YAML contract per website. The source of truth.
fixtures/            the JSON the collectors actually returned.
```

## Verification

```bash
pnpm verify   # format, lint, typecheck (including the dashboard), 263 tests
pnpm build
```

`any` is a lint error rather than a style preference: every boundary is parsed with
zod, so an untyped value means a boundary was skipped. `@weaver/core` performs no
I/O at all — no `fs`, no `fetch`, no clock reads — which is why the drift engine and
the heal-prompt synthesiser are exhaustively testable without a network.

CI runs the full suite on every push, plus a chaos matrix asserting that each of the
eight mutations still triggers the finding it simulates. A second workflow collects
from all three sources every six hours, heals what broke under the gated policy,
commits the recorded runs, and opens an issue when healing gives up.

## Documentation

- `docs/JUDGE.md` — each judging criterion mapped to the file that satisfies it
- `CONTEXT.md` — the domain vocabulary. Read this first.
- `docs/targets.md` — why these three sites, and the robots.txt evidence
- `docs/adr/` — the four decisions worth arguing about
- `docs/agent-integration.md` — MCP setup and the guard rails
- `AGENTS.md`, `CLAUDE.md`, `CODEX.md` — working agreements and pinned Collector IDs

## Data collected

Public product data only: brand name, composition, MRP, selling price, currency,
discount, stock status. No reviews, no reviewer names, no personal data, nothing
behind a login. `docs/targets.md` has the robots.txt analysis, and there is a test
that fails the build if a contract ever points at a disallowed path.

## AI assistance disclosure

Built with AI coding assistance (Kiro, running Claude). The architecture, the target
selection, every decision recorded in `docs/adr/`, and every dependency choice were
made and reviewed by the author, who can explain any part of the system. Generated
code was read before it was committed.
