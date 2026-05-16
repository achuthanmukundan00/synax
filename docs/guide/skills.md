# Skills

Synax skills extend the agent's capabilities by injecting skill instructions
into the agent's system context before each model step.

Skills come from two sources:

1. **Config-based skills** (`.synax.toml` `[skills]`): explicit path entries to
   `SKILL.md` or `persona.md` files. These are always loaded — ideal for product
   personas (AutoCareer job buddy, wytOS creative partner).

2. **Auto-discovered skills**: Synax scans `~/.synax/skills/` (global) and
   `.synax/skills/` (project-local) for subdirectories containing `SKILL.md`
   files. These are discovered automatically — ideal for ambient domain skills
   (lint conventions, style guides).

## Skill Ordering

Config-based skills (personas) are injected **first**, followed by auto-discovered
skills. This ensures the model internalizes the core persona identity before
applying project-specific domain conventions.

## Auto-Discovery

Synax scans two directories for `SKILL.md` files:

- `~/.synax/skills/<skill-name>/SKILL.md` — global skills (user-installed)
- `.synax/skills/<skill-name>/SKILL.md` — project-specific skills

Each skill is a directory containing a `SKILL.md` file with optional YAML
frontmatter:

```markdown
---
name: 'TypeScript Conventions'
description: 'Project TypeScript style guide'
enabled: true
---

# Instructions

- Use strict mode
- Prefer interfaces over type aliases
```

If `enabled` is `false` in the frontmatter, the skill is discovered but not
loaded. If no `name` is provided, the directory name is used.

## Config-Based Persona Skills

For product personas (large, product-specific identity files), use the
`[skills]` config section in `.synax.toml`:

```toml
[skills]
enabled = ["./personas/career-coach/persona.md"]
```

Config-based skills are always loaded, even with `--no-skills`. This lets
products run "pure persona only" without ambient domain skills.

## Disabling Auto-Discovery

Use `--no-skills` to disable auto-discovered ambient skills while preserving
config-based persona skills:

```bash
synax run --task "help me draft a resume" --no-skills
synax chat --no-skills
```

## Config Path Skill Format (detailed)

For explicit config-based skill entries, Synax resolves paths to files. Synax resolves the path to
a `SKILL.md` file and loads its content.

Supported path forms:

- **Home-relative**: `~/.agents/skills/coderabbit-review` — expands `~` to your home directory
- **Absolute**: `/opt/skills/my-skill/SKILL.md` — used directly
- **Project-relative**: `./project-skills/lint-checker` — resolved from the project root

If the resolved path is a directory, Synax appends `/SKILL.md` automatically.
If it's a file, it's used directly.

Bare names (without `/` or `\`) are not supported — always use a path.

## Configuration

```toml
[skills]
enabled = ["~/.agents/skills/coderabbit-review"]
disabled = ["~/.agents/skills/grill-me"]
```

- **enabled**: Config-based skill paths loaded into the agent context
- **disabled**: Skill paths explicitly turned off

If a path is listed in neither array, it defaults to disabled.

## Inspecting Skills

```bash
synax inspect --skills           # List all discovered skills
synax inspect --skill <name>     # Show full instructions for a skill
```

## Diagnostics

At startup, Synax resolves each enabled skill path and reports:

- Skill id/path
- Resolved absolute path
- Whether `SKILL.md` exists
- Whether the skill was loaded and injected

Missing or broken skills surface clear diagnostics instead of allowing
the model to discover skills on its own.

## Skill Requirements

Each skill must provide a `SKILL.md` manifest file with the skill's instructions.
The file content is injected as a system-level message into the agent context.
