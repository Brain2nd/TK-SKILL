---
name: fastmoss-creator-harvest
description: Automatically collect and filter FastMoss TikTok creator candidates, save CSV results, and enrich publicly listed emails through the project's creator-search MCP server. Use when the user asks Claude to run the FastMoss JS injection workflow, scrape or export FastMoss creators, find TikTok Shop affiliates, collect low-follower or low-sales candidates, retrieve public creator emails, resume an interrupted harvest, or merge FastMoss CSV files. Do not ask the user to open DevTools, copy cookies, or paste JavaScript.
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
   limit. The tool opens the managed Playwright browser, logs in when needed,
   applies filters, captures FastMoss responses, and writes a CSV.
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

## Enrich emails

Call `harvest_fastmoss_emails` with the collection CSV. The tool automatically
derives authentication cookies from the managed browser session; never request
or accept a copied Cookie header.

If the result is `rate_limited`, stop and preserve the partial output. After a
few minutes, call the tool again on that output. Existing emails are skipped,
so the run resumes rather than starting over.

Use `merge_fastmoss_csvs` to combine rounds and deduplicate by username,
preferring rows containing an email.

## Human verification

When the tool reports `fastmoss_verification_required`, tell the user to finish
CAPTCHA, SMS, or other verification in the browser window opened by the tool.
Retry after verification. Never bypass site access controls or rotate identities
to evade a block or rate limit.
