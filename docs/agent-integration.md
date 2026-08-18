# Driving Weaver from a coding agent

Bright Data's guidance for this workflow is blunt: the terminal is the UI, and if
a project needs three dashboard tabs open, something has gone wrong. Weaver takes
that literally. The whole reliability loop is available as MCP tools, so an agent
can run it conversationally, and the dashboard is a read-only view for people who
want to look at it rather than a control panel you have to use.

## The two MCP servers, and why both

| Server                  | Gives the agent                                                             |
| ----------------------- | --------------------------------------------------------------------------- |
| Bright Data's MCP       | general scraping tools: `scrape_as_markdown`, `search_engine` and others    |
| Weaver's MCP (`weaver`) | the reliability loop: collect, diagnose, heal with a contract gate, compare |

They are complementary. Bright Data's tools fetch the web; Weaver's tools decide
whether what came back is trustworthy and repair the collector when it is not.

Add Bright Data's:

```sh
npx -p @brightdata/cli bdata add mcp     # interactive: Claude Code, Cursor or Codex
```

Weaver's is already configured for Claude Code in `.mcp.json` at the repo root, so
opening this project is enough. For other agents:

```sh
# Codex
codex mcp add weaver -- npx tsx packages/mcp/src/main.ts

# Cursor — add to .cursor/mcp.json
{ "mcpServers": { "weaver": { "command": "npx", "args": ["tsx", "packages/mcp/src/main.ts"] } } }
```

## The five tools

| Tool                    | Read-only | What it does                                                      |
| ----------------------- | --------- | ----------------------------------------------------------------- |
| `weaver_list_sources`   | yes       | every source, its Collector ID, and the verdict of its last run   |
| `weaver_collect`        | no        | trigger a collector (`live`) or replay the last recorded run      |
| `weaver_diagnose`       | yes       | every contract violation, and the exact heal prompt it would send |
| `weaver_heal`           | no        | the verify-then-approve loop; requires `confirm: true`            |
| `weaver_compare_prices` | yes       | same molecule across pharmacies, normalised to price per unit     |

`weaver_heal` is annotated `destructiveHint: true`, so a well-behaved client will
ask before calling it.

## Three guard rails an agent cannot talk its way past

These are structural, not advisory. They are in the code, and there are tests that
fail if they stop working.

1. **`weaver_heal` refuses without `confirm: true`.** Confirmation is a required
   field in the tool's input schema, so an agent cannot omit it and cannot infer
   that skipping it would be helpful.
2. **`weaver_heal` refuses under a `manual` heal policy** and says which setting
   to change. Whichever of the environment and the contract is more cautious wins.
3. **The contract gate is inside the engine, not the tool.** An agent gets the
   same verify-then-approve behaviour the CLI gets, because there is no code path
   that skips it. `--auto-approve` is never passed to `bdata`, by anyone.

## The conversation this is built for

```
you    prices look wrong on Truemeds
agent  [weaver_list_sources] Truemeds' last run is broken, 15 rows.
agent  [weaver_diagnose source=truemeds]
       mrp is missing from all 15 rows. The prompt I would send is:
       "mrp" is missing from all 15 rows. "mrp" is the printed maximum retail
       price in rupees, before any discount is applied. Observed: "mrp" came
       back empty. Re-capture "mrp" from the current markup and leave every
       other field untouched. Return "mrp" as a plain number with no currency
       symbol.
you    go ahead
agent  [weaver_heal source=truemeds confirm=true]
       Attempt 1 (describe-all) — approved.
       preview: 3 rows — the preview satisfied the contract for "mrp" across 3 rows
       healed: the re-run satisfies the contract and the incident is closed.
```

No dashboard was opened. A recorded transcript of this loop against the live
collector is in `docs/transcripts/`.

## Pinning the Collector IDs

Bright Data recommends pinning the `c_*` ID in the agent's rules file so the agent
reuses the scraper instead of building a new one every session. Weaver does that
in three places, one per agent: `CLAUDE.md`, `CODEX.md` and
`.cursor/rules/weaver.mdc`.

The authoritative copy is the `collector_id` field in each `sources/*.yaml`. The
rules files are a convenience for the agent, and if the two ever disagree the YAML
wins — it is the file the code actually reads.
