# CLAUDE.md

Weaver is a self-healing web data control plane built on Bright Data Scraper Studio.
Read `CONTEXT.md` for the domain vocabulary and `AGENTS.md` for the working
agreements before changing code.

## Pinned Bright Data Collector IDs

Reuse these. Do not run `bdata scraper create` for a source that already has an
ID — generation takes 5 to 25 minutes and healing keeps the ID stable, so a new
scraper is almost never the right answer.

```sh
TRUEMEDS_COLLECTOR_ID=c_msz4j3yo230n7kzhbe
DAWAADOST_COLLECTOR_ID=c_msz4k0rsm4wpfezt3
APOLLO_COLLECTOR_ID=c_msz4k329ghj4p6o3y

# Run a pinned collector directly
RUN_SCRAPER="bdata scraper run $TRUEMEDS_COLLECTOR_ID <url> --pretty"
```

The authoritative copy of each ID is the `collector_id` field in the matching
`sources/*.yaml`. If these two ever disagree, the YAML wins.

## Prefer Weaver's own tools over raw CLI calls

Weaver ships an MCP server. It is already configured in `.mcp.json`, so these
tools are available in this project:

| Tool                    | Use it for                                                        |
| ----------------------- | ----------------------------------------------------------------- |
| `weaver_list_sources`   | what is being watched, and the state of the last run              |
| `weaver_collect`        | trigger a collector, or replay the last recorded run              |
| `weaver_diagnose`       | why a source is unhealthy, and the heal prompt Weaver would send  |
| `weaver_heal`           | the verify-then-approve loop; needs `confirm: true`               |
| `weaver_compare_prices` | the product: same molecule, three pharmacies, normalised per unit |

Reach for `weaver_diagnose` before `weaver_heal`. Diagnosis is read-only, costs
nothing, and prints the exact prompt — so the prompt can be improved before a
credit is spent.

## Rules that matter here

- **Never pass `--auto-approve` to `bdata scraper heal`.** Weaver's entire point
  is that the preview is verified against the contract before approval. If you
  need an unattended heal, use `weaver_heal`, which runs that gate.
- **Never widen a contract to make a failure go away.** If `mrp` stopped
  extracting, heal the scraper. Lowering `min_fill_rate` hides the problem, which
  is the failure mode this project exists to prevent.
- **Change a field's `description` only if the field's meaning changed.** That
  sentence creates the scraper, validates every run and writes the heal prompt.
- **Never print an API key.** Not in logs, not in commit messages, not on screen.
  The demo is a screen recording.
- **Run `pnpm verify` before committing.** Format, lint, typecheck, tests.

## Everyday commands

```sh
pnpm weaver doctor                                  # environment and contracts
pnpm weaver collect --all --mode replay             # spends nothing
pnpm weaver collect --source truemeds --mode live   # spends credits
pnpm weaver check --explain                         # latest verdict per source
pnpm weaver chaos --source truemeds --mutation null-field --field mrp
pnpm weaver heal --source truemeds --dry-run        # print the prompt only
```

`WEAVER_MODE` defaults to `replay`, so nothing costs money unless `--mode live`
is passed explicitly.
