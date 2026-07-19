---
name: search-kol-creators
description: Search and filter TikTok, Instagram, or YouTube creators through a user-selected TikHub or FastMoss data source. Use when a user asks an AI agent to find KOLs, influencers, affiliates, TikTok Shop creators, or creator contact candidates by keywords, countries, follower counts, views, engagement, sales, GMV, or categories, and expects the agent to request the correct credential and run the matching source.
---

# Search KOL Creators

Route each request through exactly the source selected by the user. Use the
`creator-search` MCP server from this repository.

## Workflow

1. Extract the requested characteristics into a `features` object. Preserve the
   user's limits; do not silently broaden them.
2. If the user did not specify a source, ask them to choose `tikhub` or
   `fastmoss`. Do not run either source before they choose.
3. Call `get_creator_search_access` with the selected source.
4. Request only the credential named in `request_from_user`:
   - TikHub: request `api_key` for every search, then call
     `search_tikhub_creators_by_features`.
   - FastMoss: request `username` and `password` only when the saved browser
     session is unavailable, then call `search_fastmoss_creators_by_features`.
5. Return the normalized results and `output_file` when present. State whether
   the result is `complete` or `partial` and report any warnings.

Never call both sources unless the user explicitly requests a comparison.

## Feature schema

Pass only applicable fields:

```json
{
  "keyword": "beauty",
  "countries": ["ES", "FR"],
  "min_followers": 1000,
  "max_followers": 10000,
  "min_avg_views": 2000,
  "max_avg_views": 100000,
  "min_engagement_rate": 0.03,
  "min_units_sold": 1,
  "max_units_sold": 10000,
  "min_gmv": 0,
  "max_gmv": 50000,
  "creator_categories": ["beauty"],
  "product_categories": ["skincare"],
  "shop_affiliates_only": true,
  "extra_filters": {"Video Count": [5, 100]}
}
```

TikHub requires `keyword`. FastMoss accepts the remaining filters without a
keyword. Use decimal engagement rates: `0.03` means 3%.

## Credential safety

- Pass credentials only to the matching MCP call.
- Do not write credentials to `.env`, JSON, shell history, source files, logs,
  CSV output, or messages.
- Do not echo a credential back to the user.
- FastMoss stores only its browser session under the ignored output profile; it
  does not store the supplied username or password.
- If FastMoss displays CAPTCHA, SMS, or another human verification step, ask the
  user to complete it in the opened browser. Do not bypass it.

## Errors

- `source_required`: ask the user to choose a source.
- `tikhub_auth_required`: ask for the TikHub API key and retry once.
- `fastmoss_auth_required`: ask for FastMoss username/password and retry once.
- `fastmoss_verification_required`: let the user finish verification, then retry
  without asking for the password again if the session became ready.
- `fastmoss_blocked`: stop. Explain that FastMoss blocked the browser session;
  do not loop, rotate identities, or attempt to evade the site's protection.
- `fastmoss_rate_limited`: stop and wait before retrying; do not start a new
  login session.
- `fastmoss_busy`: another search is using the browser profile; wait for that
  search to finish instead of launching a second browser.
