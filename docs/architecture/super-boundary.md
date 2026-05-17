# Super Boundary

Synax is the portable coding-agent runtime. It owns generic runtime primitives:

- `SynaxRuntime`
- `SynaxTask`
- `SynaxAgent`
- `SynaxTool`
- `SynaxToolRegistry`
- `SynaxMemoryAdapter`
- `SynaxEvent`
- `SynaxRunResult`
- `SynaxOrchestrator`

Synax may support single-agent runs, parallel and sequential subagents, handoff,
FTS5-backed local memory, tool calling, event streaming, and Relay-backed LLM
clients.

Synax does not own Super.

Do not put these concerns in Synax core:

- Super world documents
- mutable self models
- persistent daemon lifecycle
- pulse or dream cycles
- Discord bot lifecycle
- career prompts
- AutoCareer evidence models
- job-search domain tools

Super may call Synax. Synax must not import Super or AutoCareer.
