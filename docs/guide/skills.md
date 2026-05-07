# Skills

Synax skills extend the agent's capabilities. They are loaded from `~/.agents/skills/`.

## Skill Directory Structure

```
~/.agents/skills/
  coderabbit-review/
    SKILL.md
  grill-me/
    SKILL.md
```

Each skill is a directory containing a `SKILL.md` manifest file.

## Configuration

```toml
[skills]
enabled = ["context7", "grill-me"]
```

- **enabled**: Skills that are active
- **disabled**: Skills explicitly turned off

If a skill is not listed in either array, it defaults to disabled.

## Built-in Skills (Discovered)

Synax discovers skills from your `~/.agents/skills/` directory:

| Skill | Description |
|-------|-------------|
| `coderabbit-review` | AI code review of working tree changes |
| `grill-me` | Harsh critique of ideas, plans, or code |
| `context7` | Resolve library docs during coding tasks |

## Managing Skills in the TUI

Press `/` and type `skills` to open the Skills tab in settings:

- **✓ context7** — Enabled
- **✓ grill-me** — Enabled
- **○ release-notes** — Disabled
- **! broken-skill** — Missing SKILL.md manifest

Press Space or Enter to toggle a skill on/off. Changes persist to the config file.

## Broken Skills

Skills shown as broken (`!`) have a missing or invalid `SKILL.md` manifest.
Fix the manifest file to re-enable the skill.

## Skill Requirements

Each skill directory must contain:
- `SKILL.md` — a manifest file with skill name, description, and instructions

Future versions may support:
- `package.json` with metadata
- Version constraints
- Skill dependencies
