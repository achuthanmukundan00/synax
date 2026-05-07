# Skills

Synax skills extend the agent's capabilities by injecting skill instructions
(SKILL.md manifests) into the agent's system context before each model step.

## Skill Entry Format

Skill entries in `.synax.toml` are filesystem paths. Synax resolves the path to
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

- **enabled**: Skills loaded into the agent context
- **disabled**: Skills explicitly turned off

If a skill path is listed in neither array, it defaults to disabled.

## Skill Directory Conventions

Many tools install skills under `~/.agents/skills/<name>/SKILL.md`.
The Synax settings TUI discovers skills from this directory for display,
but injection requires explicit path-based configuration.

Example directory layout:

```
~/.agents/skills/
  coderabbit-review/
    SKILL.md
  grill-me/
    SKILL.md
```

## Managing Skills in the TUI

Press `/` and type `skills` to open the Skills tab in settings.
The TUI shows discovered skills from `~/.agents/skills/`.

Press Space or Enter to toggle a skill on/off. Changes persist to the config file.

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
