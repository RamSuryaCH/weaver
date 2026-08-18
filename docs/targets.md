# Target selection and compliance

Why these three sites, and the evidence that collecting from them is allowed.
Verified 2026-08-18.

## The rule being satisfied

Bright Data's guidance for this work is explicit: build for the long tail, not
against the pre-built library. If a judge would ask why you did not just use the
pre-built scraper, the target is wrong. Separately, only publicly available data
may be collected — nothing behind a login, a paywall, or a personal account.

## The sources

| Source          | Host                    | Why it is long-tail                                                                                                 |
| --------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Truemeds        | `www.truemeds.in`       | Indian online pharmacy with generic substitution. Absent from Bright Data's pre-built library.                      |
| Dawaa Dost      | `www.dawaadost.com`     | Generic-first Indian pharmacy. The low-price anchor that makes the savings comparison meaningful.                   |
| Apollo Pharmacy | `www.apollopharmacy.in` | India's largest pharmacy chain. Still absent from a library that covers global marketplaces, not regional pharmacy. |

Bright Data's pre-built catalogue covers large global marketplaces and social
platforms. Regional Indian pharmacy catalogues are exactly the "everything else"
that Scraper Studio exists for.

## robots.txt

Checked directly, 2026-08-18.

- **truemeds.in** — permissive. Disallows `/cart`, `/login`, `/search`,
  `/upload-prescription`, `/myorders` and other account paths. Product pages
  under `/medicine/` and `/otc/` are allowed.
- **dawaadost.com** — `allow: /`, with `/cgi-bin/`, `/temp/`, `/tmp/`,
  static-admin paths and the dev/stage hosts disallowed. Publishes eleven
  sitemaps.
- **apollopharmacy.in** — `Allow: /`, with `/search/`,
  `/medicine/search-medicines/`, `/medicines-cart*`, `/my-account`,
  `/health-records` and other account paths disallowed. Publishes
  `sitemap/sitemap-master.xml`.

No URL in any contract touches a disallowed path, and there is a test that fails
the build if one ever does — see `packages/config/src/sources.test.ts`.

**Ruled out: medplusmart.com.** Its Akamai edge returns `Access Denied` even for
`robots.txt`, so there is no permission signal to rely on. Dropped rather than
worked around.

## Public accessibility

Each site was checked with a single ordinary request, no session and no cookies:

| Source          | Status | Price visible                                           |
| --------------- | ------ | ------------------------------------------------------- |
| Truemeds        | 200    | `"price":44.55,"priceCurrency":"INR"` in JSON-LD        |
| Dawaa Dost      | 200    | `"price":"71","priceCurrency":"INR"` in JSON-LD         |
| Apollo Pharmacy | 200    | `"price":35.5` in JSON-LD, `₹44.5` in the rendered page |

No pincode gate, no login wall, no paywall. Truemeds additionally publishes
`schema.org/Drug` markup with `activeIngredient`, `manufacturer` and
`dosageForm`, which is why composition-based matching across sites is possible
at all.

## What is collected, and what is not

Collected: product URL, brand name, composition, MRP, selling price, currency,
discount percentage, stock status. Later, by way of a heal: pack size,
prescription-required flag, manufacturer.

Not collected, deliberately: reviews, reviewer names, ratings tied to
individuals, prescription uploads, order history, or anything else that could
identify a person. There is no personal data in Weaver's database.

## Input selection

Fifteen product URLs per source, chosen so that ten medicines appear on all
three sites. That overlap is what makes cross-pharmacy comparison possible, and
the small list keeps a full collection cycle to 45 page loads — roughly seven
cents of Bright Data credit.

Pack sizes deliberately differ between sites for the same medicine (10s, 15s,
20s). Comparing pack prices would be dishonest, so the price comparison
normalises to price per unit. See `docs/adr/`.

Two of the shared medicines, Pan 40 and Pantop 40, are both pantoprazole 40 mg
from different manufacturers. That is the brand-versus-brand comparison the
product is built to expose.
