# EU5 TikTok Shop Creator Sample — 2026-07-17

> Historical benchmark only: the TikHub sheet records an earlier comparison run.
> Production routing now requires all TTS data to come from FastMoss; TikHub is
> used only for Instagram and YouTube data (plus explicitly non-TTS analysis).

## Deliverables

- `../eu5_10_tikhub_20260717/final.csv`: 10 creators discovered through TikHub.
- `../eu5_10_fastmoss_20260717/final.csv`: 10 creators discovered through the authenticated FastMoss website.
- `combined.csv`: both source-specific results in one 20-row comparison file.

## Applied rules

- Country is one of ES, FR, DE, IT, GB.
- Follower count is greater than 0 and below 10,000.
- TikTok Shop/Showcase is verified.
- Public email is non-empty and its domain publishes an MX record.
- Spanish creators rank before creators from the other four countries.

The legacy TikHub sheet used a recent-video product anchor with showcase products
as fallback. The FastMoss sheet used the creator detail page's “Showcase open”
status. Under the current validator, only the FastMoss sheet is a valid production
TTS output.
