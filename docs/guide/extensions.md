# Extensions

Synax provides a typed extension system for customizing agent behavior. Extensions can react to lifecycle events, intercept tool calls, register custom tools, add custom tool-call parsers, and define recovery strategies.

## Extension Interfaces

All extension interfaces are defined in `src/extensions/interfaces.ts`. The built-in implementations live in `src/extensions/builtins.ts`.

```
src/extensions/
  interfaces.ts    # Type definitions for all extension points
  builtins.ts      # createBuiltinExtensions() — default implementations
  index.ts         # Re-exports
```

Synax assembles extensions from built-in defaults and any user-registered overrides via the config system.

## EventBus Subscriptions

The EventBus (`src/events/EventBus.ts`) is the primary extension mechanism. Two channel types are available.

### Lifecycle Events (fire-and-forget)

Subscribe to specific events or use a wildcard to listen to everything:

```ts
import { EventBus } from 'synax';

const bus = new EventBus();

// Subscribe to a specific lifecycle event
bus.on('turn_start', (event) => {
  console.log(`Turn ${event.stepIndex} started`);
});

// Subscribe to all tool execution completions
bus.on('tool_execution_end', async (event) => {
  if (!event.success) {
    console.error(`Tool ${event.toolName} failed: ${event.error}`);
  }
});

// Wildcard — listen to everything (logging, metrics, tracing)
bus.onAny((event) => {
  console.log(`[${event.type}] ${event.timestamp}`);
});
```

**Available lifecycle events:**

| Event | Payload | When |
|-------|---------|------|
| `session_start` | `mode`, `model` | Agent boots up |
| `session_shutdown` | `terminalState` | Agent shuts down |
| `turn_start` | `stepIndex`, `task` | New turn begins |
| `turn_end` | `stepIndex`, `terminalState`, `toolCalls`, `steps` | Turn completes |
| `tool_execution_start` | `toolCallId`, `toolName`, `arguments` | Before tool runs |
| `tool_execution_end` | `toolCallId`, `toolName`, `success`, `error` | After tool runs |
| `before_compact` | `estimatedInputTokens`, `inputLimit` | Compaction about to run |
| `session_compact` | `stage`, `tokensBefore`, `tokensAfter` | Compaction completed |
| `child_session_spawned` | `parentSessionId`, `childSessionId` | Handoff spawned child |
| `child_session_completed` | `parentSessionId`, `childSessionId`, `result` | Child session completed |
| `child_session_failed` | `parentSessionId`, `childSessionId`, `error` | Child session failed |

All lifecycle handlers run in parallel. Individual handler errors are caught and swallowed — they never crash the agent.

### Control Hooks (can intercept)

Control hooks allow extensions to allow, block, or observe tool calls before execution:

```ts
import { EventBus } from 'synax';

const bus = new EventBus();

// Block dangerous bash commands
bus.onControl('pre_tool_use', (event) => {
  if (event.toolName === 'bash') {
    const args = event.arguments as Record<string, unknown>;
    const cmd = String(args.command ?? '');

    if (cmd.includes('rm -rf /') || cmd.includes('sudo')) {
      return {
        allow: false,
        reason: `Dangerous command blocked: ${cmd}`,
      };
    }
  }
  return { allow: true };
});

// Log all file writes
bus.onControl('pre_tool_use', (event) => {
  if (event.toolName === 'write') {
    const args = event.arguments as Record<string, unknown>;
    console.log(`Write attempt: ${args.path} (${String(args.content ?? '').length} chars)`);
  }
  return { allow: true };
});
```

**Available control hooks:**

| Hook | When | Return type |
|------|------|-------------|
| `pre_tool_use` | Before any tool executes | `{ allow: true }` or `{ allow: false, reason }` |
| `post_tool_use_failure` | After a tool fails | `{ allow: true }` or `{ allow: false, reason }` |

Control hooks run sequentially. The first handler returning `allow: false` short-circuits the chain. This lets you layer safety gates — a restrictive gate first, followed by logging.

### Unsubscribing

Both `on()` and `onControl()` return cleanup functions:

```ts
const unsubscribe = bus.on('turn_start', handler);
// Later:
unsubscribe();
```

Call `bus.destroy()` to remove all listeners during shutdown.

## Custom Tools

Register new action handlers in the `ActionExecutor` to add custom tool capabilities.

### Step 1: Define the handler

Create a handler module following the `ActionHandler` interface:

```ts
// src/actions/handlers/time-handler.ts
import type { ActionHandler } from '../types';

export const timeHandler: ActionHandler = {
  kind: 'get_time' as any, // extend ActionKind in types.ts for full type safety
  execute: async (action) => {
    const now = new Date().toISOString();
    return {
      result: `Current UTC time: ${now}`,
      exitCode: 0,
    };
  },
  describe: () => 'get current time',
};
```

### Step 2: Register in the handler map

```ts
// In src/actions/ActionExecutor.ts, inside createDefaultHandlerMap():
import { timeHandler } from './handlers/time-handler';

export function createDefaultHandlerMap(): HandlerMap {
  const map = new Map();
  map.set('read', readHandler);
  map.set('edit', editHandler);
  map.set('write', writeHandler);
  map.set('bash', bashHandler);
  map.set('search_memory', searchMemoryHandler);
  map.set('view_image', viewImageHandler);
  map.set('get_time', timeHandler); // new
  return map;
}
```

### Step 3: Expose to the model

Add the tool to the model-facing tool definitions in `src/session/tool-definitions.ts`:

```ts
{
  type: 'function',
  function: {
    name: 'get_time',
    description: 'Get the current UTC time in ISO 8601 format',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
}
```

### Complete example: Time tool

```ts
import { ActionExecutor, createDefaultHandlerMap } from 'synax';

const executor = new ActionExecutor(createDefaultHandlerMap());

// The model can now call: { name: "get_time", arguments: {} }
const result = await executor.execute({
  kind: 'get_time',
  arguments: {},
  toolCallId: 'call_123',
});
console.log(result.result); // "Current UTC time: 2026-05-12T10:30:00.000Z"
```

## Custom Tool-Call Parsers

Add support for new model families by implementing the `ToolCallParser` interface:

```ts
import type { ToolCallParser, ToolCallParseResult } from 'synax';

const myParser: ToolCallParser = {
  parseContent(content: string): ToolCallParseResult {
    // Your parsing logic here
    // Extract tool calls from raw model output
    const toolCalls = extractToolCallsFromMyModelFormat(content);

    if (toolCalls.length === 0) {
      return { content, toolCalls: [] };
    }

    return {
      content: stripToolCallMarkers(content),
      toolCalls: toolCalls.map((tc) => ({
        id: `call_${tc.index}`,
        type: 'function' as const,
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.args),
        },
      })),
    };
  },

  // Optional: parse native tool_calls array from API response
  parseNative?(toolCalls: unknown): ToolCallParseResult {
    // Handle provider-specific native format
    return { content: '', toolCalls: [] };
  },
};
```

Register the parser in `src/llm/parsers/registry.ts`:

```ts
parserRegistry.register('my_model', myParser);
```

Users then configure it in `.synax.toml`:

```toml
[providers.custom]
tool_call_parser = "my_model"
```

## Custom Repairers

When models emit malformed JSON or XML, Synax attempts repair before giving up. Add custom repair logic:

```ts
import type { ToolCallRepairer, ToolCallRepairContext } from 'synax';

const myRepairer: ToolCallRepairer = {
  repairMalformedJson(raw: string, context?: ToolCallRepairContext): string | null {
    // Attempt to fix common patterns in your model's output
    if (raw.includes('function_call:')) {
      // Convert custom format to valid JSON
      return convertMyFormatToJSON(raw);
    }
    return null; // return null if can't repair
  },

  repairMalformedXml?(raw: string, context?: ToolCallRepairContext): string | null {
    // Attempt to fix broken XML tags
    return null;
  },
};
```

## Custom Recovery Recipes

Register failure recovery strategies with the `RecoveryManager`:

```ts
import { RecoveryManager } from 'synax';
import type { RecoveryAction, RecoveryContext, RecoveryResult } from 'synax';

const recovery = new RecoveryManager();

recovery.register({
  scenario: 'timeout_recovery',
  maxAttempts: 2,
  async execute(context: RecoveryContext): Promise<RecoveryResult> {
    const nudge = [
      'The previous operation timed out.',
      'Try a simpler approach or break the task into smaller steps.',
      'If you were reading a large file, try reading a smaller section.',
    ].join('\n\n');

    context.conversation.messages.push({ role: 'user', content: nudge });

    return {
      recovered: true,
      injectedMessage: nudge,
      conversation: context.conversation,
    };
  },
});
```

**Custom recipe pattern:**

1. Define a unique `scenario` string
2. Set `maxAttempts` to limit retry count
3. In `execute`, craft a nudge message tailored to the failure
4. Push the nudge into the conversation as a `user` message
5. Return `{ recovered: true, injectedMessage, conversation }`

## Compaction Techniques

The `DeterministicCompactor` applies composable techniques. Each technique is a pure function:

```ts
type Technique = (text: string) => { text: string; changed: boolean };
```

Current techniques (applied in priority order):

1. **stripAnsiCodes** — remove terminal color escapes
2. **stripStackTraces** — collapse `node_modules/` lines
3. **stripDuplicateLines** — collapse repeated stdout
4. **dedupRepeatedPatterns** — merge identical messages
5. **collapseWhitespace** — trim indentation and blank lines

Each technique is measured independently. Token savings are reported per-technique in the compaction stats.

## MCP Bridge

Synax provides groundwork for guarded MCP (Model Context Protocol) export/import. The bridge preserves Synax tool policy, approval/checkpoint policy, verification policy, and context/budget policy.

```ts
import type { McpBridge, McpExportedTool, McpImportedTool } from 'synax';

const bridge: McpBridge = {
  exportNativeTool: (tool: McpExportedTool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }),

  async importTool(tool: McpImportedTool) {
    // Validate against Synax policy
    if (!tool.policy.readOnly) {
      return { ok: false, reason: 'policy-rejected' };
    }
    if (!tool.policy.boundedOutput) {
      return { ok: false, reason: 'policy-rejected' };
    }
    return {
      ok: true,
      tool: {
        name: tool.name,
        description: tool.description ?? '',
        parameters: tool.inputSchema,
        policy: tool.policy,
      },
    };
  },
};
```

Currently, MCP import returns `{ ok: false, reason: 'unsupported' }` for all tools — the bridge is scaffolded for future implementation.

## Hello World Example

A complete working example is in `examples/hello-world-extension/`:

```
examples/hello-world-extension/
  SKILL.md         # Skill that teaches the agent a pirate accent
  extension.ts     # EventBus subscriber that logs every tool call
  README.md        # Explanation and usage instructions
```

To use it:

```sh
synax chat --skill examples/hello-world-extension
```

The example demonstrates:
- Writing a SKILL.md with YAML frontmatter
- Subscribing to lifecycle events
- Logging tool calls with a custom subscriber

## See Also

- [Architecture](/guide/architecture) — module relationships and data flow
- [Skills](/guide/skills) — SKILL.md format and discovery
- [MCP](/guide/mcp) — MCP bridge details
- [Source: EventBus](https://github.com/achuthanmukundan00/synax/blob/main/src/events/EventBus.ts)
- [Source: extensions/interfaces.ts](https://github.com/achuthanmukundan00/synax/blob/main/src/extensions/interfaces.ts)
- [Source: extensions/builtins.ts](https://github.com/achuthanmukundan00/synax/blob/main/src/extensions/builtins.ts)
