# ADR 0001 — Inject `fetch` and `sleep` instead of intercepting HTTP

**Status:** accepted · 2026-08-18

## Context

`@weaver/brightdata` talks to the Bright Data Collection API and has to be tested
thoroughly: it is the boundary where a shape change, a 429, or a snapshot that
never finishes will show up first. The obvious approaches are `nock` or `msw`.

Both had problems here. Node 22's `fetch` is undici rather than `http`, so
interception is version-sensitive. And the polling loop is the part most worth
testing — trigger, poll, poll, ready — which with a real timer means a test that
either sleeps for fifteen seconds or reaches for fake timers, which interact
badly with promises.

## Decision

The client takes `fetch`, `sleep` and `now` as constructor options, defaulting to
the real implementations.

Tests pass a stub that replays queued `Response` objects and a clock that only
advances when the client sleeps.

## Consequences

The whole boundary is covered by 21 tests that run in 9ms with no network and no
interception library: retry backoff is asserted as `[1000, 2000, 4000]` by reading
the recorded sleeps, and the snapshot timeout is asserted without waiting.

It also means the CI `verify` job needs no Bright Data credentials, so a fork or a
pull request from a stranger runs the full suite.

The cost is three extra constructor options on a public type. That is a small
price, and it makes the dependency on time and network explicit rather than
ambient, which is a property worth having anyway.
