# Validation matrix

Automated tests must cover:

| Scenario | Expected result |
|---|---|
| Valid canonical/legacy import | Preview first; execute only on explicit flag |
| Unsupported schema, duplicate handle, invalid email | Reject or retain as non-sendable |
| Missing screening approval | Skip `screening_not_approved` |
| DNC, unsubscribe, complaint, bounce | Skip `suppressed` |
| Contact channel not allowed | Skip without provider call |
| Dry-run batch | Exact message preview, no journal/CRM/provider mutation |
| Analyzer offline preview | Selected country rows rendered; zero SMTP, DM and Feishu writes |
| Empty Hook | Client base template reproduced exactly |
| Evidence-bound Hook | Only the standalone Hook changes; locked price/deliverable/CTA/signature remain exact |
| Unsafe Hook or unknown placeholder | Reject or fall back without changing a locked block |
| Pending or edited manifest | Execute rejects it |
| Template ID/version/SHA or Hook evidence edited after approval | Execute rejects it |
| Stage/contact/sender changes after approval | Execute skips or rejects mismatched item |
| Approved channel removed after review | Reject without provider call |
| Existing step01 event | Skip `already_sent` |
| Two local processes | Second process cannot enter send/monitor loop |
| Provider explicit rejection | `failed`, no stage advance |
| Provider result unknown | `delivery_unknown`, no automatic retry |
| Provider success, CRM failure | `sent_pending_sync`, journal blocks resend |
| Reply journaled, CRM update/log failure | Reconciler retries by reply key without duplicate email log |
| Personalized opening | Same text in text/HTML; at most one tracking pixel |
| Header injection | Subject newlines removed |
| Reply with rate/currency/usage/media kit | Structured fields, `Outreach Pool = Private` |
| Shared MCN email | Match by Message-ID; ambiguous email fallback is skipped |
| Unsubscribe or bounce reply | Suppress future contact |
| Seven days no reply | One follow-up, original sender, original thread |
| Fixed Offer with disabled follow-up | Never receives the old rate-inquiry follow-up |
| DM first contact | Never trigger a cross-channel email follow-up |
| Delayed old reply after newer reply | Persist the email log but retain the newest CRM state |
| Open pixel without reply | Does not change the seven-day rule |
| Follow-up already sent/unknown | Never send a second follow-up |

Run:

```bash
cd scaffolds/kol-email-outreach
npm test
```

Then validate the Skill and search for TODO/placeholders before handoff.
