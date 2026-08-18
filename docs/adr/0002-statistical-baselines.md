# ADR 0002 — Baselines are medians of healthy runs, not fixed thresholds

**Status:** accepted · 2026-08-18

## Context

Weaver has to answer "is this run wrong?" A contract can express absolute rules —
`mrp` must be a number above zero — and those catch a lot. They do not catch the
failure this project exists for.

A field that has always been populated on 60% of rows is fine at 60% and broken at
5%. No fixed threshold expresses that: set the floor at 60% and it fires forever on
a healthy source, set it at 5% and it never fires at all. Only history knows what
normal looks like.

This matters more than usual because the Scraper Studio AI generates a
best-effort output schema: when a page genuinely has no discount, the field is
omitted from that row rather than set to null. Absence is normal, and its rate is
the signal.

## Decision

Every run is compared against two things: the contract, and a baseline built from
the **median** of previous **healthy** runs.

Three rules make it trustworthy:

1. **Only `ok` runs contribute.** Including a broken run teaches the baseline that
   broken is normal, which is how monitoring systems go quiet.
2. **Medians, not means.** Scraped price data has outliers, and one bad run should
   not drag the baseline.
3. **At least three healthy runs** (`MIN_BASELINE_RUNS`) before baseline
   comparisons switch on. With fewer, one unlucky run becomes "normal" and every
   subsequent run drifts against noise. Contract checks apply from the first run,
   so a new source is never unguarded.

## Consequences

A brand-new source is protected by its contract immediately and gains drift
detection once it has a history. That is the right order: absolute rules need no
history, relative ones cannot work without it.

Two derived rules follow from the same reasoning, both in `drift.ts`:

- `field_absent` only fires when something was expected — the field is required,
  or has a fill-rate floor, or history says a quarter of rows used to carry a
  value. Reporting an optional field that no product happens to have would train
  the operator to ignore Weaver.
- Type coercion (`"₹214.50"` for a number field) is counted but only reported when
  it exceeds half the present values. Occasional formatting noise is not a break;
  systematically wrong types are.
