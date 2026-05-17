# SDK embedding: AutoCareer + Synax

Embed Synax as a single-agent coding runtime for AI-assisted resume/job tasks.

```
AutoCareer
  ┌─────────────────────────────────────┐
  │  new SynaxRuntime({                 │
  │    model, tools, memory,            │
  │    policy, onEvent                  │
  │  })                                 │
  │  result = await runtime.run({       │
  │    input: "draft a bullet point..." │
  │  })                                 │
  └──────────┬──────────────────────────┘
             │ RuntimeEvent stream
             ▼
        { status, output,
          filesChanged,
          toolCalls, steps }
```

## Quick start

```ts
import { SynaxRuntime } from 'synax';
import type { RuntimeResult, RuntimeEvent } from 'synax';

const runtime = new SynaxRuntime({
  model: {
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen3:8b',
  },
  workingDir: '/home/user/project',
});

const result: RuntimeResult = await runtime.run({
  input: 'Fix the login button alignment',
});

console.log(result.status);   // 'completed'
console.log(result.output);   // final answer
console.log(result.filesChanged);
```

## AutoCareer example

This example shows a realistic AutoCareer integration:

- **Memory adapter** backed by SQLite (via HolographicMemory)
- **Custom tool** `draftResumeBullet` that the model can call
- **Event streaming** for progress in the UI
- **Result handling** for both success and failure

```ts
import { SynaxRuntime, HolographicMemory } from 'synax';
import type {
  RuntimeEvent, RuntimeResult,
  ToolDefinition, ToolResult,
} from 'synax';

// ── Custom tool: draft a resume bullet point ──────────────
const draftBulletTool: ToolDefinition = {
  name: 'draftResumeBullet',
  description: 'Draft a resume bullet point given the context',
  inputSchema: {
    type: 'object',
    properties: {
      role: { type: 'string' },
      accomplishment: { type: 'string' },
    },
    required: ['role', 'accomplishment'],
  },
  safetyPolicy: { readOnly: true, rejectsUnsafePaths: false, boundedOutput: true },
  ledgerBehavior: 'none',
  async execute(input: { role: string; accomplishment: string }): Promise<ToolResult> {
    const bullet = `• ${input.role}: ${input.accomplishment}`;
    return { success: true, toolName: 'draftResumeBullet', output: { bullet } };
  },
};

// ── Memory adapter: persist across jobs ───────────────────
const memory = new HolographicMemory('autocareer-memory.db');

// ── Events: show progress ─────────────────────────────────
function onEvent(e: RuntimeEvent): void {
  switch (e.type) {
    case 'started':
      console.log('Job started');
      break;
    case 'model_step':
      process.stdout.write('.');
      break;
    case 'tool_start':
      console.log(`\n[${e.toolName}] running...`);
      break;
    case 'tool_finish':
      console.log(`[${e.toolName}] ${e.success ? 'done' : 'failed'}`);
      break;
    case 'error':
      console.error(`Error: ${e.message}`);
      break;
    case 'complete':
      console.log(`\nStatus: ${e.status}`);
      break;
  }
}

// ── Runtime ───────────────────────────────────────────────
const runtime = new SynaxRuntime({
  model: {
    baseUrl: process.env.LLM_BASE_URL ?? 'http://127.0.0.1:11434/v1',
    model: process.env.LLM_MODEL ?? 'qwen3:8b',
  },
  tools: [draftBulletTool],
  memory,
  onEvent,
  workingDir: process.cwd(),
});

// ── Run ───────────────────────────────────────────────────
const result: RuntimeResult = await runtime.run({
  input: 'Draft a resume bullet for my role as a software engineer',
});

// ── Handle result ─────────────────────────────────────────
if (result.status === 'completed') {
  console.log('Output:', result.output);
  console.log(`Tools used: ${result.toolCalls}, Steps: ${result.steps}`);
} else {
  console.error(`Failed (${result.status}): ${result.error}`);
}
```

## Events

Events are emitted in this order during a run:

| Order | Event              | When                              |
|-------|--------------------|-----------------------------------|
| 1     | `started`          | Run begins                        |
| 2+    | `model_step`       | Model is thinking                 |
| 3+    | `model_step_started` | Model step turn begins          |
| 4+    | `task_started`     | Run-level task started            |
| 5+    | `model_response`   | Raw model response text           |
| 6+    | `tool_start`       | A tool starts executing           |
| 7+    | `tool_finish`      | A tool finishes (success/err)     |
| 8+    | `task_finished`    | Run-level task finished           |
| 9+    | `token_usage`      | Token consumption snapshot        |
| 10+   | `error`            | Recoverable error occurred        |
| last  | `complete`         | Run finished with status          |

## Result shape

```ts
interface RuntimeResult {
  status:        'completed' | 'error' | 'blocked' | 'policy_blocked';
  output:        string;         // model's final answer
  filesChanged:  string[];       // files modified
  toolCalls:     number;         // tool invocations
  steps:         number;         // model turns
  error?:        string;         // present on failure
}
```

## What is NOT exposed

SynaxRuntime intentionally hides internal state:
- No `AgentConversation` — message history stays private
- No `Session` — turn loop is encapsulated
- No `EventBus` — only mapped `RuntimeEvent` objects reach the caller
- No handoff, orchestration, or subagents — single-agent only

## Memory adapter notes

Memory adapter methods (`store`, `search`, `buildMemoryIndex`) accept both sync and
async implementations. Sync adapters (e.g. in-memory) return values directly. Async
adapters (e.g. Postgres, Redis) return Promises — the runtime `await`s them
automatically. The existing `HolographicMemory` (SQLite) is sync by default.

## Public imports

```ts
import { SynaxRuntime } from 'synax';
import { HolographicMemory } from 'synax';

import type { MemoryAdapter, MemoryEntry, MemorySearchResult } from 'synax';
import type { Policy, ToolUseRequest, FileEditPreview } from 'synax';
import type { RuntimeEvent, RuntimeResult, RuntimeConfig, RuntimeRunInput, RuntimeStatus } from 'synax';
import type { ModelConfig, RunMode } from 'synax';
import type { ToolDefinition, ToolResult } from 'synax';
```

## Config options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `model` | `ModelConfig` | required | LLM endpoint config |
| `memory` | `MemoryAdapter` | null | Pluggable memory backend |
| `tools` | `ToolDefinition[]` | [] | Custom tools for the model |
| `policy` | `Policy` | — | Approval policy for tool/file-edit |
| `mode` | `RunMode` | `'patch'` | Agent mode (`read-only`, `patch`, `verify`, `docs`) |
| `onEvent` | `(e: RuntimeEvent) => void` | — | Event stream callback |
| `onBudget` | `(s: AgentBudgetSnapshot) => void` | — | Token budget snapshots |
| `onActivity` | `(a: AgentActivity) => void` | — | Activity updates |
| `sessionId` | `string` | auto | Stable ID for memory persistence |
| `bashEnabled` | `boolean` | true | Enable shell tools |
| `contextBudget` | `Partial<ContextBudgetSettings>` | — | Token budget limits |
| `maxOutputTokens` | `number` | — | Per-response token cap |
| `logger` | `Logger` | — | Structured logging |
| `workingDir` | `string` | `process.cwd()` | File operation root |

## Run input options

| Option | Type | Description |
|--------|------|-------------|
| `input` | `string` | The task description |
| `context` | `string` | Prepended context |
| `sessionId` | `string` | Per-run session ID (overrides config) |
| `signal` | `AbortSignal` | Cancellation handle |

## Memory adapter health

Check bridge health with `getMemoryStatus()`:

```ts
const status = runtime.getMemoryStatus();
if (status && !status.available) {
  console.warn(`Memory degraded: ${status.storeErrors} store errors`);
}
```

Returns `null` when no adapter is configured, or `{ available, storeErrors, searchErrors, indexErrors }`.
