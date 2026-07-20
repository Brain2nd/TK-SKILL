# TK-SKILL

[简体中文](README.zh-CN.md) | English

> Looking for the LOOP Creator OS MVP? Start with the [Chinese user guide](README.zh-CN.md) or the [detailed workspace documentation](scaffolds/kol-email-outreach/ui/README.md).

Collected Lark/Feishu agent skills plus TikHub-powered KOL workflow scaffolds.

## Contents

- `skills/`: 25 ready-to-use skills
- `skills/kol-first-outreach/`: safe first-contact with rate-inquiry or locked fixed-offer templates, persona Hook evidence, approval, reply handoff, and intent-aware follow-up
- `skills/lark-skill-maker/`: skill scaffolding and authoring guidance
- `skills/lark-workflow-*`: reusable workflow skills
- `scaffolds/tikhub-kol-analyzer/`: TikTok creator discovery, filtering, and scoring pipeline
- `scaffolds/kol-email-outreach/`: approved-batch first outreach, analyzer CSV preview, protected template input, reply capture, rate extraction, and CRM handoff
- `scaffolds/kol-email-outreach/ui/`: Chinese Campaign workspace for sender setup, evidence-bound AI personalization, per-email approval, and guarded local SMTP execution

Each skill is self-contained and starts from its own `SKILL.md`. The projects under
`scaffolds/` are runnable reference implementations with setup instructions in their
respective README files.

## Usage

Copy or link the desired directory under `skills/` into the skills directory used by
your agent runtime, then follow that skill's `SKILL.md`. For a scaffold, enter its
directory and follow its README.

## Security

Runtime configuration, environment files, credentials, logs, caches, and user data are intentionally excluded.
