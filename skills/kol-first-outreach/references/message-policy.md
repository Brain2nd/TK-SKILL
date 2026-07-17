# Step01 message policy

## Supported first-contact intents

- `rate_inquiry`: use the default step01 template and the one-time seven-day rate follow-up.
- `fixed_offer`: use only an explicitly approved `first-contact-template.v1`. Commercial terms are literal locked blocks and `followup.mode` must remain `disabled` until a matching follow-up template is approved.

## Fixed commercial intent

Ask only for:

- current rate for the requested deliverable;
- currency;
- media kit or rate card, if available;
- whether standard usage rights are included.

Do not include a brand budget, product allowance, commission, free-gift promise, final deliverables, deadline, contract term, or statement that the collaboration is confirmed.

## Personalization boundary

For an input template, require exactly one standalone `{{personalized_hook}}` paragraph. The model returns only one hook sentence plus evidence IDs. It never receives authority to rewrite the subject or assembled body. When the hook is empty or invalid, remove its entire paragraph and reproduce the base client template.

The only other allowed placeholders are deterministic values: `creator_name`, `creator_handle`, `sender_name`, and `brand_name`. Do not use a handle as a real name. If no verified display name exists, keep a neutral greeting such as `Hi!`.

Require every concrete reference to be supported by the supplied bio, category, or recent-video data. When recent-video evidence is absent, refer only to the content niche. Never infer or mention sensitive traits such as race, skin color, age, bank details, address, or private contact information.

Fall back to the deterministic public-trait Hook, or to the unmodified base template when no supported trait exists, if the model times out, returns invalid JSON, lacks evidence, or introduces unsupported claims.

## One-time follow-up

The follow-up may restate the same rate/currency/media-kit/usage-rights request, but must not add an offer, deadline, urgency claim or new deliverable. For an email first contact, it is sent once after seven days without a reply, regardless of open-pixel data, from the original sender in the existing email thread. A DM first contact never falls across to an email follow-up, and the current allowed-channel policy is rechecked before sending.

This rule applies only to `rate_inquiry`. A `fixed_offer` event with `followup_mode=disabled` is skipped by the monitor; it must never receive the old rate-inquiry follow-up.

## Review checklist

- Text and HTML show the same personalized Hook.
- Every locked block appears exactly once and matches the approved client text.
- `content_template_id`, version and SHA-256 match the reviewed template file.
- Hook evidence IDs and any unresolved review warnings are visible in the batch.
- No unresolved `{{variable}}` remains.
- Subject contains no newline or injected header.
- Sender display name matches the actual mailbox.
- The email contains a low-friction opt-out sentence.
- No claim implies that a specific video was viewed unless its description is present in the input snapshot.
