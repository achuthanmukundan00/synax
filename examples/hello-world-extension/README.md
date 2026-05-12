# Hello World Extension

A minimal example demonstrating Synax's extension system.

## What This Example Shows

1. **SKILL.md** — A skill file with YAML frontmatter that teaches the agent to speak in a pirate accent. Skills are injected as system messages into the agent conversation.

2. **extension.ts** — An EventBus subscriber that logs every tool call start and end, turn boundaries, and registers a `pre_tool_use` control hook. This demonstrates:
   - Lifecycle subscriptions (`on()`)
   - Control hooks (`onControl()`)
   - Cleanup pattern (returning unsubscribe functions)

## How to Use

### As a Skill

```sh
synax chat --skill examples/hello-world-extension
```

The pirate skill will be injected as an additional system message. The agent will respond in a pirate accent while maintaining technical accuracy.

### Programmatic Extension

```ts
import { Session } from 'synax';
import { helloWorldExtension } from './examples/hello-world-extension/extension';

const session = new Session({
  repoRoot: process.cwd(),
  client: myClient,
  mode: 'patch',
});

// Attach the extension
const cleanup = helloWorldExtension(session.eventBus);

// Run the agent
await session.start();

// Clean up when done
cleanup();
```

## File Structure

```
hello-world-extension/
├── SKILL.md        # Skill file (YAML frontmatter + instructions)
├── extension.ts    # EventBus subscriber implementation
└── README.md       # This file
```

## What You'll See

When the extension is active, each tool call produces console output like:

```
🔧 Tool: read (call call_abc123)
   Args: path=src/session/Session.ts, offset=1, limit=50
✅ read: ok

── Turn 1 ──
🔧 Tool: search_memory (call call_def456)
   Args: query=error recovery
✅ search_memory: ok

── Turn 1 end: completed, 2 tool call(s), 1 step(s)
```

## Next Steps

From here, you can:

- Copy this directory and modify `SKILL.md` to create your own skill
- Extend `extension.ts` to add safety gates (block dangerous commands)
- Add a custom action handler for a new tool
- Register a custom recovery recipe

See `docs/guide/extensions.md` for the full extensions API reference.
