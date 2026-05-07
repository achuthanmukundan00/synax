# MCP Servers

Synax supports MCP (Model Context Protocol) servers for extending tool capabilities.

## Configuration

MCP servers are configured in `[mcp.servers]`:

```toml
[mcp.servers.context7]
enabled = true
command = "npx"
args = ["-y", "@upstash/context7-mcp"]

[mcp.servers.filesystem]
enabled = false
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "."]
```

## Server Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `enabled` | boolean | No (default: true) | Whether the server starts with Synax |
| `command` | string | Yes | The command to launch the server |
| `args` | string[] | No | Command arguments |
| `env` | object | No | Environment variables for the server process |

## Environment Variables

```toml
[mcp.servers.github]
enabled = true
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github"]

[mcp.servers.github.env]
GITHUB_TOKEN = "${GITHUB_TOKEN}"
```

## Managing MCP Servers in the TUI

Press `/` and type `mcp` to open the MCP tab in settings:

- **✓ context7** — Enabled, shows `npx -y @upstash/context7-mcp`
- **○ filesystem** — Disabled
- **! github** — Missing `GITHUB_TOKEN` env var

Press Space or Enter to toggle a server on/off.

## Context7 MCP Example

Add to `.synax.toml`:

```toml
[mcp.servers.context7]
enabled = true
command = "npx"
args = ["-y", "@upstash/context7-mcp"]
```

This gives Synax access to up-to-date library documentation during coding tasks.

## Validation

Synax validates MCP configurations:
- Missing `command` → error shown in settings
- Missing environment variables that contain `TOKEN` → warning shown
- Invalid JSON schema → server marked as broken

## Limitations (Current)

- MCP tool import is guarded and requires explicit policy approval
- Servers are validated on startup but not auto-started yet
- Server process management is planned for a future release
