# TK-SKILL

Collected Lark/Feishu agent skills plus TikHub-powered KOL workflow scaffolds.

## Contents

- `skills/`: 24 ready-to-use skills
- `skills/lark-skill-maker/`: skill scaffolding and authoring guidance
- `skills/lark-workflow-*`: reusable workflow skills
- `scaffolds/tikhub-kol-analyzer/`: TikTok creator discovery, filtering, and scoring pipeline
- `scaffolds/kol-email-outreach/`: email and TikTok DM outreach automation with CRM tracking

Each skill is self-contained and starts from its own `SKILL.md`. The projects under
`scaffolds/` are runnable reference implementations with setup instructions in their
respective README files.

## Usage

Copy or link the desired directory under `skills/` into the skills directory used by
your agent runtime, then follow that skill's `SKILL.md`. For a scaffold, enter its
directory and follow its README.

## Security

Runtime configuration, environment files, credentials, logs, caches, and user data are intentionally excluded.
