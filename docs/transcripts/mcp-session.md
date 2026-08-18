# A recorded agent session

An unedited recording of the Weaver MCP server driving the reliability loop from a
coding agent, taken against the live database on 2026-08-18. Reproduce it with
`node packages/mcp/src/main.ts` registered as an MCP server, or with the config in
`.mcp.json`.

Only the shell prompts have been added for readability. Every tool response below
is verbatim.

```text
[server stderr] weaver mcp: 3 sources, mode replay, heal policy gated, bright data key present

$ tools/list
  weaver_list_sources  (readOnly=true, destructive=false)
  weaver_collect       (readOnly=false, destructive=false)
  weaver_diagnose      (readOnly=true, destructive=false)
  weaver_heal          (readOnly=false, destructive=true)
  weaver_compare_prices (readOnly=true, destructive=false)
```

The annotations matter: a well-behaved client can see which tools change the world
before it calls one.

```text
$ tools/call weaver_list_sources {}

- apollo-pharmacy (Apollo Pharmacy, pdp): collector c_msz4k329ghj4p6o3y, last run broken at 2026-08-18T20:40:17.736Z with 15 rows
- dawaadost (Dawaa Dost, pdp): collector c_msz4k0rsm4wpfezt3, last run broken at 2026-08-18T20:40:12.807Z with 15 rows
- truemeds (Truemeds, pdp): collector c_msz4j3yo230n7kzhbe, last run degraded at 2026-08-18T20:38:51.743Z with 15 rows
```

Three real collectors, and none of them healthy. These are the scrapers Bright
Data's AI generated, on their first live run, and every one of them has a defect.

```text
$ tools/call weaver_diagnose {"source":"truemeds"}

Truemeds — last run degraded at 2026-08-18T20:38:51.743Z (live, 15 rows).

selling_price — value_invalid (degraded)
  "selling_price" failed validation in 1 of 15 rows: 300107.5 is not less than 100000
  observed: 300107.5
  expected: the price in rupees a customer actually pays today, after any discount

The heal prompt Weaver would send:
"selling_price" failed validation in 1 of 15 rows: 300107.5 is not less than 100000. "selling_price" is the price in rupees a customer actually pays today, after any discount. Observed: "selling_price" came back as 300107.5. Re-capture "selling_price" from the current markup and leave every other field untouched. Return "selling_price" as a plain number with no currency symbol.
```

Rosuvas 10 has an MRP of ₹375 and the scraper reported a selling price of
₹300,107.50. `weaver_diagnose` is read-only: it contacted Bright Data not at all,
spent nothing, and still produced the exact prompt it would send — so the prompt
can be judged before a credit is spent on it.

```text
$ tools/call weaver_heal {"source":"apollo-pharmacy","confirm":false}

Refusing to heal apollo-pharmacy without confirm: true. This would send a prompt to Bright Data and may change the collector. Call weaver_diagnose to see the prompt first.
```

Confirmation is a required field in the tool's input schema, so an agent cannot
omit it, and cannot decide on its own that skipping it would be helpful.

```text
$ tools/call weaver_compare_prices {"limit":3}

No molecule available from more than one pharmacy matches "".
```

This is the most useful line in the session, and it is a failure.

The price comparison needs `composition` to group two pharmacies' products into the
same molecule. Dawaa Dost returned `composition` on 2 of 15 rows and Apollo on 4 of
15, so there is nothing to compare — the product does not work, because the data is
wrong.

That is the whole argument for this project in one output. The scrapers ran. They
returned rows. Row counts looked fine. Nothing threw. And the thing built on top of
them is empty, because a field that nobody checked came back null. Weaver's answer
is that the contract checks it, names it, and repairs it, and the product comes
back when the data does.

## What happened next

`weaver heal --source dawaadost` sent that prompt to `bdata scraper heal`. The
approval gate returned a preview, Weaver ran the preview through the same contract,
and rejected it: **"composition" is still empty in the preview**. The collector was
left untouched, and the next prompt was sharpened from that specific sentence.

The full audit trail — every prompt with its character count, every preview, every
approve-or-reject decision and why — is in the dashboard at `/incidents`, and in
`incident_events` if you would rather read it in SQL.

## An upstream fault worth recording

`bdata scraper approve --reject` answered HTTP 500 with
`sprintf invalid format %j (ide_automation %s (status=%s): %j)` — a fault inside
Bright Data's job resumption, not in the repair. The CLI itself reported that the
scraper was unchanged and still working, which is exactly what a rejection is for.

Weaver now records that outcome as incident evidence and carries on to the
sharpened prompt rather than abandoning the repair over a cosmetic upstream error.
See `rejectQuietly` in `packages/engine/src/heal.ts`, and the test named "carries on
when the reject call itself fails upstream".
