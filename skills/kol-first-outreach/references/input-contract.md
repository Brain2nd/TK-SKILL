# Input contract

首次建联 Agent 将人物画像视为只读快照。人物画像模块负责发现、清洗、画像和筛选；建联模块只消费结果并产生建联事件。

## Canonical v1 object

```json
{
  "schema_version": "outreach-candidate.v1",
  "candidate_id": "tiktok:stable-user-id",
  "platform": "tiktok",
  "handle": "creator_handle",
  "display_name": "Creator Name",
  "profile_snapshot_id": "snapshot-uuid",
  "screening_run_id": "screening-run-uuid",
  "contacts": {
    "emails": [{ "address": "creator@example.com", "status": "valid", "source": "bio" }]
  },
  "profile": {
    "bio": "...",
    "followers": 120000,
    "primary_category": "fashion haul",
    "preferred_language": "en",
    "recent_videos": [{ "video_id": "...", "description": "...", "hashtags": ["haul"] }]
  },
  "screening": {
    "decision": "approved",
    "ruleset_version": "screening-v1"
  },
  "contact_policy": {
    "do_not_contact": false,
    "allowed_channels": ["email"]
  }
}
```

## Current CRM compatibility aliases

| Canonical | Accepted CRM fields |
|---|---|
| `candidate_id` | `candidate_id`, `Candidate ID`, `user_id`, `User ID`; canonical input requires a stable value, while legacy CSV temporarily falls back to `platform:handle` |
| `handle` | `username`, `Creator Username`, `handle` |
| `display_name` | `display_name`, `Display Name`, `nickname`, `tiktok_nickname`, `username` |
| `email` | `email`, `Email`, `Contact Email` |
| approval | `Screening Decision`, `screening_decision`, `Outreach Approved`, `outreach_approved` |
| suppression | `Do Not Contact`, `do_not_contact`, `Opt Out`, `Suppressed`, bounce/complaint status |

Run `npm run outreach:setup` to preview the outreach-owned CRM fields. The outreach module owns only contact workflow fields such as `candidate_id`, screening trace IDs, approval, allowed channels, suppression, quote details, `Contact Status` and `Outreach Pool`. Persona content and scores remain read-only.

## Send gate

Require all conditions:

1. Stage is exactly `00_Discovered`.
2. Handle is syntactically valid.
3. Screening decision is approved when `require_screening_approval` is enabled.
4. No suppression signal exists.
5. A valid email exists, unless this batch explicitly enables DM fallback.
6. No successful event exists for `campaign_id + candidate_id + step01`.
7. The selected channel appears in `contact_policy.allowed_channels` / `Allowed Channels`.

Never write biography, category, demographic, follower, video, email-source, or screening-score fields from the outreach process.

## Import compatibility

`import_candidates.mjs` accepts canonical JSON/JSONL and the legacy analyzer CSV. It defaults to dry-run, normalizes handles/emails, deduplicates by stable ID, rejects unsupported schemas and refuses handle-to-ID conflicts. A legacy final CSV has no explicit approval metadata; using it requires both `--approve-legacy-final-csv` and a traceable `--screening-run-id`. Binding an existing CRM row that has no stable ID additionally requires `--bind-legacy-handles` after manual identity verification.

The EU analyzer adapter also accepts `avg_views_10`, `engagement_rate`, `shop_signals`, `email_source`, and `email_verified`. These fields support review and public-trait extraction; follower/view metrics are not quoted in the message. Analyzer `email_verified` is domain/MX validation rather than proof of mailbox ownership, and `shop_signals`/UGC keywords do not prove that a creator can add a TikTok Shop product link.

Use `preview_analyzer_batch.mjs` for an entirely offline handoff test. It emits JSON/HTML previews only and never sends, writes Feishu, or creates an executable approved manifest.
