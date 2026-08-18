# AGENTS.md

Weaver is a self-healing web data control plane built on Bright Data Scraper Studio.
Read `CONTEXT.md` for the domain vocabulary before changing anything.

## Working agreements

- **Contracts are the source of truth.** A field's plain-language `description` in
  `sources/*.yaml` is used to create the scraper, to validate every run, and to
  repair the scraper. Change the description and you have changed all three.
- **`@weaver/core` performs no I/O.** No `fs`, no `fetch`, no clock reads. If a
  function needs the current time or a network call, it takes it as an argument.
  This is why the drift engine is testable without a network.
- **Every boundary is parsed with zod.** Bright Data responses, environment
  variables and YAML all arrive as `unknown` and leave as types. `any` is a lint
  error, not a style preference.
- **Never print a credential.** Use `maskSecret` from `apps/cli/src/ui.ts`. This
  rule exists partly because the demo video is a screen recording.
- **Run `pnpm verify` before committing.** Format, lint, typecheck and tests.

## Bright Data collector IDs

Pinned so an agent reuses the existing scrapers instead of spending 15 minutes
regenerating them. See `CLAUDE.md` for the copy the Bright Data CLI docs expect.

| Source          | Collector ID      | Contract                       |
| --------------- | ----------------- | ------------------------------ |
| Truemeds        | _not created yet_ | `sources/truemeds.yaml`        |
| Dawaa Dost      | _not created yet_ | `sources/dawaadost.yaml`       |
| Apollo Pharmacy | _not created yet_ | `sources/apollo-pharmacy.yaml` |

Healing keeps the Collector ID stable, so these values should only ever change
when a brand-new scraper is created.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues, driven by the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, with label strings equal to their names. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` at the root plus `docs/adr/`. See `docs/agents/domain.md`.
