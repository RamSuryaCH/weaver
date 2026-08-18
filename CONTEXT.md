# CONTEXT.md

The vocabulary Weaver uses. If a term here has a definition, use that term and
not a synonym — including in test names, issue titles and commit messages.

## The problem being modelled

A scraper does not fail loudly. A class name changes, a field starts returning
`null`, and the pipeline downstream keeps running on quietly degrading data.
Bright Data Scraper Studio provides the repair primitive (`bdata scraper heal`,
which keeps the same Collector ID). Weaver provides the judgement around it:
when to heal, what to say in the heal prompt, and whether the repair worked.

## Core terms

**Source** — one website Weaver collects from, described by exactly one file in
`sources/`. Identified by a lower-kebab-case id such as `dawaadost`.

**Source contract** — the parsed, validated form of a `sources/*.yaml` file. The
single source of truth for a source: what to collect, what "healthy" means, and
what Weaver is allowed to do on its own.

**Field contract** — one field within a source contract. Carries the
plain-language **description** that is used three times: to create the scraper,
to validate every run, and to write the heal prompt.

**Collector** — the scraper as it exists inside Bright Data Scraper Studio,
addressed by its **Collector ID** (`c_*`). Healing mutates the collector in
place, so the ID is a permanent handle and is safe to hard-code downstream.

**Run** — one execution of a collector over a source's inputs. Produces rows.

**Row** — one record returned by a run; for a pharmacy source, one medicine on
one site at one point in time.

**Field statistics** — per-field measurements computed from a run: fill rate,
distinct count, numeric summary. The raw material of drift detection.

**Baseline** — the trailing aggregate of previous healthy runs that the current
run is compared against. Statistical rather than absolute, because the Scraper
Studio AI schema is best-effort per row: a legitimately absent field is omitted
rather than nulled, so an absolute threshold produces false alarms.

**Finding** — one specific problem detected in a run, naming the field, the
observed number, and the expectation it failed.

**Run report** — the findings for a run plus an overall **severity**.

**Severity** — `ok`, `degraded` or `broken`. Degraded means the data is usable
but the contract is slipping; broken means downstream should not trust it.

**Drift** — a change in the shape or distribution of collected data rather than
an outright error. Includes the quiet case where every row suddenly carries the
same value, which looks like success until you read it.

**Incident** — the lifecycle record opened when a run report is not `ok` and
closed when the source is healthy again. Carries the **MTTR**.

**Heal prompt** — the sub-1000-character instruction sent to
`bdata scraper heal`, synthesized from the field description plus the observed
symptom. Never handwritten at runtime.

**Approval gate** — the point where `heal` stops and returns a
`preview_result` for review. Weaver's central design decision lives here.

**Verify-then-approve** — Weaver validates the heal's `preview_result` against
the same contract that detected the break, and only then approves. A heal is
trusted because the output satisfies the contract, not because the AI produced
it. The alternative, `--auto-approve`, trusts it blindly.

**Heal policy** — `manual` (report only), `gated` (verify-then-approve) or
`auto` (approve without the gate). Defaults to `gated` everywhere.

**Escalation** — what happens when heal attempts are exhausted: a GitHub issue,
so a human inherits a described problem rather than a silent gap.

**Chaos harness** — the test facility that feeds deliberately mutated payloads
through the real detection path, so a break can be demonstrated on demand
instead of waiting for a site redesign. It never fabricates a scrape.

**Run mode** — `live` triggers real collectors and spends credits; `replay`
reads recorded runs from `fixtures/`. Replay is the default so that cloning the
repo is enough to explore the product.

## Words we avoid

- "Selector" as the unit of repair. Weaver repairs from **descriptions**; the
  selector is Bright Data's business and is deliberately invisible here.
- "Scraper" when **collector** is meant. A collector is the deployed thing with
  an ID; "scraper" is the general concept.
- "Error" when **finding** is meant. A finding is a contract violation, which
  may or may not be an error in the exception sense.
- "Alert" when **incident** is meant. Weaver opens incidents; alerting is one
  possible output of one.
