# CODEX.md

Weaver is a self-healing web data control plane built on Bright Data Scraper Studio.
Read `CONTEXT.md` for the domain vocabulary and `AGENTS.md` for the working
agreements before changing code.

## Pinned Bright Data Collector IDs

```sh
SCRAPER_STUDIO_COLLECTOR_ID=<not created yet>          # Truemeds
DAWAADOST_COLLECTOR_ID=<not created yet>
APOLLO_COLLECTOR_ID=<not created yet>

TRUEMEDS_SCRAPER_USAGE="bdata scraper run $SCRAPER_STUDIO_COLLECTOR_ID <url> --pretty"
```

Reuse them rather than creating new scrapers: generation takes 5 to 25 minutes,
and `bdata scraper heal` repairs in place without changing the ID. The
authoritative copy of each ID is the `collector_id` in the matching
`sources/*.yaml`; if they disagree, the YAML wins.

## Weaver's MCP tools

Register the server once:

```sh
codex mcp add weaver -- npx tsx packages/mcp/src/main.ts
```

Then prefer these over raw CLI calls:

- `weaver_list_sources` — what is watched, and the last run's verdict
- `weaver_collect` — trigger a collector, or replay the last recorded run
- `weaver_diagnose` — why a source is unhealthy, plus the heal prompt it would send
- `weaver_heal` — the verify-then-approve loop; requires `confirm: true`
- `weaver_compare_prices` — same molecule, three pharmacies, normalised per unit

Diagnose before healing. Diagnosis is read-only and free.

## Rules

- Never pass `--auto-approve` to `bdata scraper heal`; the contract gate is the product.
- Never relax a contract to silence a finding. Heal the scraper instead.
- Never print an API key.
- `pnpm verify` before committing.
