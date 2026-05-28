# Settings Menu

The interactive settings menu is the primary way to configure Synax at runtime.

## Opening Settings

From the TUI, type `/` and select **settings**, or press `/` and type `settings`:

```
/settings  Open settings menu
```

The settings menu opens as a full-screen modal overlay.

## Navigation

| Key    | Action                                    |
| ------ | ----------------------------------------- |
| ← / →  | Switch tabs                               |
| ↑ / ↓  | Move selected row                         |
| Enter  | Select / toggle / edit                    |
| Space  | Toggle checkbox                           |
| Escape | Close settings                            |
| q      | Close settings (when not editing text)    |
| /      | Close settings, open command autocomplete |

## Tabs

### Model

- **Active Provider**: Select from enabled providers
- **Active Model**: Select from provider's model list, or choose **No model** to leave the core unloaded
- **Thinking**: Set thinking level (off/low/medium/high/auto)

Models that don't support thinking show the thinking control as dimmed/disabled.
When **No model** is selected, model submissions are blocked until a model is selected again.

### Providers

Lists all configured providers with:

- Enabled/disabled status (✓/○)
- Compatibility type
- Base URL (sanitized)
- Model count

### Skills

Lists auto-discovered skills from `~/.synax/skills/` and `.synax/skills/`, plus
config-based skills from `.synax.toml` (e.g. `~/.agents/skills/coderabbit-review`):

- ✓ — Enabled
- ○ — Disabled
- ! — Broken (missing manifest)

Toggle with Space or Enter.

### MCP

Lists configured MCP servers:

- ✓ — Enabled
- ○ — Disabled
- ! — Configuration error (e.g., missing env var)

Toggle with Space or Enter.

### Config

Shows config status:

- Config source paths (global/local)
- Effective model
- Which config source is active
- Loaded sections (providers, models, skills, MCP)
- Validation errors if any

### Help

Quick reference for keyboard controls, config file locations, and provider setup examples.

## Persistence

Changes made in the settings menu persist automatically:

- If a local `.synax.toml` exists, changes go there
- Otherwise, changes go to `~/.config/synax/config.toml`
- If neither exists, a new `.synax.toml` is created in the current repo

## Visual Style

The settings menu follows Synax's industrial design:

- Dark background
- Aligned labels
- Subtle separators
- Muted inactive text
- Strong active-row marker (`→`)
- Grey disabled controls
- Masked secrets (API keys shown as `••••`)
