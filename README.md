# TK-SKILL

Collected Lark/Feishu agent skills plus TikHub-powered KOL workflow scaffolds.

## Contents

- `skills/`: ready-to-use agent skills, including `search-kol-creators`
- `.claude/skills/fastmoss-creator-harvest/`: auto-discovered Claude workflow for FastMoss collection and email enrichment
- `skills/lark-skill-maker/`: skill scaffolding and authoring guidance
- `skills/lark-workflow-*`: reusable workflow skills
- `scaffolds/tikhub-kol-analyzer/`: TikHub/FastMoss creator discovery, filtering, and scoring pipeline
- `scaffolds/kol-email-outreach/`: email and TikTok DM outreach automation with CRM tracking

Each skill is self-contained and starts from its own `SKILL.md`. The projects under
`scaffolds/` are runnable reference implementations with setup instructions in their
respective README files.

## Usage

For Claude Code, open this repository as the project. Claude automatically
discovers `.claude/skills/fastmoss-creator-harvest/SKILL.md` and the
`creator-search` server in `.mcp.json`. The MCP runtime and Playwright browser
are prepared automatically on first use; no DevTools, Cookie copying, or
JavaScript pasting is required.

Copy or link the desired directory under `skills/` into the skills directory used by
your agent runtime, then follow that skill's `SKILL.md`. For a scaffold, enter its
directory and follow its README.

## Security

Runtime configuration, environment files, credentials, logs, caches, and user data are intentionally excluded.
