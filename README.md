# Weaver

A self-healing web data control plane, built on Bright Data Scraper Studio.

Scrapers do not fail loudly. A class name changes, a field starts returning
`null`, and everything downstream keeps running on quietly degrading data.
Bright Data solved the repair primitive: `bdata scraper heal` fixes a scraper
from a plain-language prompt and keeps the same Collector ID, so nothing
downstream breaks. Weaver supplies the judgement around that primitive — when to
heal, what to say in the prompt, and whether the repair actually worked.

It is demonstrated on a live medicine price transparency pipeline across three
Indian online pharmacies, where wrong data has real consequences.

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
back through the same contract that detected the break, and only then approves.
If the preview fails, it rejects the fix, sharpens the prompt from the specific
failure, and tries again within a bounded budget before escalating to a human. A
heal is trusted because the output satisfies the contract — not because an AI
produced it.

## Status

Under active construction for the Into the Scrape-Verse hackathon
(17–23 August 2026). This README describes what is built so far.

- [x] Source contracts with zod validation, and `weaver doctor`
- [ ] Typed Bright Data client
- [ ] Drift detection engine
- [ ] Verify-then-approve heal loop
- [ ] Weaver MCP server
- [ ] Dashboard and price comparison

## Quickstart

Requires Node 22+ and pnpm 10+.

```bash
pnpm install
pnpm weaver doctor
```

`doctor` reports the environment, whether the Bright Data CLI is reachable, and
the state of every source contract. It needs no credentials and spends nothing.

Weaver defaults to `WEAVER_MODE=replay`, which reads recorded runs from
`fixtures/` instead of triggering collectors. Cloning the repo is therefore
enough to explore the whole product without a Bright Data account.

To run against live collectors, copy `.env.example` to `.env` and set
`BRIGHTDATA_API_KEY` (from <https://brightdata.com/cp/setting>), or run
`npx -p @brightdata/cli bdata login`.

## Layout

```
packages/core        pure domain: contracts, drift detection, heal prompts, policy. No I/O.
packages/config      loads sources/*.yaml and the environment. The only config reader.
apps/cli             the weaver command line. The primary interface.
sources/             one YAML contract per website. The source of truth.
docs/                targets and compliance, ADRs, domain vocabulary.
```

## Documentation

- `CONTEXT.md` — the domain vocabulary. Read this first.
- `docs/targets.md` — why these three sites, and the evidence that collecting
  from them is permitted.
- `AGENTS.md` — working agreements, and the pinned Collector IDs.

## Data collected

Public product data only: brand name, composition, MRP, selling price, currency,
discount, stock status. No reviews, no reviewer names, no personal data, nothing
behind a login. See `docs/targets.md` for the robots.txt analysis and the test
that enforces it.

## AI assistance disclosure

This project was built with AI coding assistance (Kiro, running Claude). The
architecture, the target selection, the design decisions recorded in `docs/adr/`
and every dependency choice were made and reviewed by the author, who can
explain any part of the system. Generated code was read before it was committed.
