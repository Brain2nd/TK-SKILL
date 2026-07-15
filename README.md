# TK-SKILL

Collected Lark/Feishu agent skills and workflow scaffolds from the TK EC2 environment.

## Contents

- `skills/`: 24 ready-to-use skills
- `skills/lark-skill-maker/`: skill scaffolding and authoring guidance
- `skills/lark-workflow-*`: reusable workflow skills

Each skill is self-contained and starts from its own `SKILL.md`.

## Usage

Copy or link the desired directory under `skills/` into the skills directory used by your agent runtime, then follow that skill's `SKILL.md`.

## Security

Runtime configuration, environment files, credentials, logs, caches, and user data are intentionally excluded.
