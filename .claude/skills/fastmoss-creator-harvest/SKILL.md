---
name: fastmoss-creator-harvest
description: Automatically collect and filter FastMoss TikTok creator candidates, save CSV results, and enrich publicly listed emails through the project's creator-search MCP server. Use when the user asks Claude to scrape or export FastMoss creators, find TikTok Shop affiliates, collect filtered candidates, retrieve public creator emails, resume an interrupted harvest, or merge FastMoss CSV files. Do not ask the user to open DevTools, copy cookies, or paste JavaScript.
---

# FastMoss Creator Harvest

Use the project-enabled `creator-search` MCP server. Never instruct the user to
copy request cookies or operate browser developer tools.

## Collect creators

1. Call `get_creator_search_access` with `fastmoss`.
2. If it returns `auth_required`, ask only for the FastMoss username and
   password, then pass them to `collect_fastmoss_candidates`. Credentials are
   used only for login; the persistent browser profile stores the website
   session, not the supplied credentials.
3. Call `collect_fastmoss_candidates` with a `features` object and a result
   limit. Candidate discovery first uses verified UI pagination and browser
   response capture. Email enrichment then runs in the authenticated browser
   network context. The `limit` is the target number of real emails; the tool
   scans up to five times as many candidates by default and writes CSV plus a
   JSON audit containing counts and warnings.
4. Return the CSV path, count, status, and warnings. Do not silently broaden
   the user's filters.

If a saved session marker is stale and collection returns
`fastmoss_auth_required`, request the username and password and retry once.

Example legacy Spanish collector criteria:

```json
{
  "features": {
    "countries": ["ES"],
    "max_followers": 9999,
    "max_units_sold": 49,
    "shop_affiliates_only": true,
    "extra_filters": {"Has Contact": true}
  },
  "limit": 5000
}
```

## Resume email enrichment

Call `harvest_fastmoss_emails` with a candidate CSV. It resumes enrichment in
the managed browser session; never request or accept a copied Cookie header.

If the result is `fastmoss_rate_limited`, stop and preserve the partial output. After a
few minutes, call the tool again on that output. Existing emails are skipped,
so the run resumes rather than starting over.

During an active collection call, keep the visible browser open when a
verification UI appears. Pause new email requests, let the user solve the
challenge in that window, and resume the pending email rows in the same browser
session after the verification UI clears. If the wait times out and collection
returns `fastmoss_verification_required`, ask the user to finish verification in
the fallback browser, then call `continue_fastmoss_after_verification` with the
returned `checkpoint_file`.

Use `merge_fastmoss_csvs` to combine rounds and deduplicate by username,
preferring rows containing an email.

## Human verification

When the tool reports `fastmoss_verification_required`, tell the user to finish
CAPTCHA, SMS, or other verification in the browser window opened by the tool.
Retry after verification. Never bypass site access controls or rotate identities
to evade a block or rate limit.
