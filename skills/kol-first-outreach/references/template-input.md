# First-contact template input

## Schema

Use JSON with `schema_version: first-contact-template.v1`:

```json
{
  "schema_version": "first-contact-template.v1",
  "content_template_id": "campaign-country-offer",
  "content_template_version": "2026-07-17.1",
  "intent": "fixed_offer",
  "language": "en",
  "subject": "Paid creator opportunity",
  "body": "Hi!\n\n{{personalized_hook}}\n\nThe client-approved opportunity paragraph.\n\nThe client-approved price and deliverable paragraph.\n\nClient-approved CTA.\n\nSender",
  "locked_blocks": [
    "The client-approved opportunity paragraph.",
    "The client-approved price and deliverable paragraph.",
    "Client-approved CTA.",
    "Sender"
  ],
  "required_reviews": [
    "recipient_email",
    "stable_candidate_identity"
  ],
  "followup": {
    "mode": "disabled"
  }
}
```

## Validation rules

- `content_template_id` is a stable content identity; it does not replace workflow `template_id=step01` or the step01 idempotency suffix.
- `content_template_version` changes whenever the client-approved content changes.
- `intent` is `rate_inquiry` or `fixed_offer`.
- The body contains exactly one standalone `{{personalized_hook}}` paragraph.
- Other placeholders, when needed, are limited to `creator_name`, `creator_handle`, `sender_name`, and `brand_name`; all are deterministic values.
- Every client-approved commercial paragraph, CTA and signature appears verbatim in `locked_blocks`, exactly once in the body, with no placeholders inside it.
- A fixed Offer uses `followup.mode=disabled` until the client approves a matching follow-up template.
- The loader rejects unknown variables, duplicate/mid-paragraph Hook slots, missing locked blocks, subject newlines and unsupported intent/follow-up combinations.

If no evidence-backed Hook exists, the renderer removes the Hook paragraph and reproduces the client base body. A Hook may not contain a price/currency, link, email, placeholder, newline or multiple sentences.

## Commands

Create a CRM-backed dry-run batch:

```bash
npm run outreach -- \
  --template outreach_templates/APPROVED_TEMPLATE.json \
  --limit 25 \
  --write-batch outreach_batches/CAMPAIGN_ID.json
```

`--template-file` is an alias. `--execute` rejects both arguments and sends only subject/body already frozen in an approved manifest.

Test analyzer output without CRM or providers:

```bash
npm run outreach:preview-analyzer -- \
  --candidates ../tikhub-kol-analyzer/output/tts_l1_eu/final.csv \
  --country ES \
  --template outreach_templates/spain-tiktok-shop-eur20.json
```

The offline preview writes JSON/HTML only. It is not an approvable send manifest.
