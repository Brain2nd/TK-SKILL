# State and idempotency

## First-send state

```text
00_Discovered
  → dry-run manifest: no CRM/provider mutation
  → approved manifest: exact recipient/sender/content hash is frozen
  → sending: durable reservation exists before provider call
  → failed: explicit provider rejection; may retry after cause is fixed
  → delivery_unknown: reconcile Sent mailbox/provider before any retry
  → sent: provider Message-ID is durable
  → crm_synced: email log is written and stage is 01_FirstOutreach
```

Use `campaign_id:candidate_id:step01`. The local process lock prevents overlapping first-send and monitor processes. A distributed deployment must replace the JSONL journal with a transactional outbox and a unique index on this key.

## Approved batch

The dry-run manifest freezes `candidate_id`, handle, channel, recipient, sender account, subject, body, `content_template_id/version/sha256`, intent, follow-up mode, Hook evidence, traits and review warnings. Approval writes reviewer, time and SHA-256 of that semantic payload. The workflow identity and idempotency suffix remain `step01`; a client content-template ID must never replace them. Execute mode rejects pending, edited, wrong-campaign or duplicate-item manifests and rechecks stable candidate identity, stage, suppression, contact address, sender availability and current daily cap. A daily slot is persisted before the provider call; only an explicit provider rejection releases it, while unknown results remain charged.

## Reply and handoff state

Use inbound Message-ID, or `inbox + UID` when Message-ID is missing, as the reply key:

```text
reply_received → reply_synced
               ↘ pending_sync → retry CRM sync without reclassifying/sending
```

`rate_quote` and `interested` end this Skill at `Outreach Pool = Private`. `declined`, `unsubscribe`, `bounce`, `out_of_office` and `needs_review` never trigger step02 automatically.

## Follow-up state

For `followup_mode=rate_inquiry_7d`, use `campaign_id:candidate_id:step01_followup`. It becomes eligible exactly once after seven 24-hour periods without `reply_received`. Keep the original sender and RFC 5322 thread. Any `sending`, `delivery_unknown` or `sent` event blocks another attempt; only the latest explicit `failed` state may be retried. For `followup_mode=disabled`, the monitor records a skip and never builds the legacy rate-inquiry follow-up.

## Failure rules

| Failure point | Action |
|---|---|
| Before reservation | Safe to retry |
| Explicit SMTP rejection | Record `failed`; fix cause before retry |
| Socket timeout/disconnect after provider call | Record `delivery_unknown`; reconcile, never blind-retry |
| Provider succeeds, sent-event write fails | Existing `sending` reservation blocks retry; reconcile |
| Journal succeeds, CRM sync fails | Report pending sync; repair CRM from journal, do not resend |
| Concurrent run | Reject the second run |

Use `outreach:reconcile` to preview confirmed `sent` events without a later `crm_synced` event and `reply_received` events without `reply_synced`. Execution requires a separate config gate and only repairs CRM state, including partially written Pipeline log/deadline artifacts; it never calls the mail or DM provider. Any remaining failure exits non-zero.
