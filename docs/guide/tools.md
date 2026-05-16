# Tools

Synax provides a set of built-in tools for local model inference. External consumers can also register custom tools programmatically.

## Built-in Tools

- `read`: Read file contents
- `bash`: Execute shell commands
- `edit`: Replace text in a file
- `write`: Create a new file
- `ls`: List files in a directory

## Custom Tool Registration (SDK)

When using Synax as an SDK, you can register custom tools that participate in budget enforcement, lifecycle events, and the session context exactly like built-in tools.

```ts
import { Session } from 'synax/session';
import type { ToolResult } from 'synax/tools';

const session = new Session({ repoRoot: process.cwd(), client });

session.registry.register({
  name: 'my_custom_tool',
  description: 'Does something specialized',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string' },
    },
    required: ['action'],
  },
  safetyPolicy: {
    readOnly: true,
    rejectsUnsafePaths: false,
    boundedOutput: true,
  },
  ledgerBehavior: 'none',
  execute: async (input: unknown, context): Promise<ToolResult> => {
    const { action } = input as { action: string };
    return {
      success: true,
      toolName: 'my_custom_tool',
      output: `Executed ${action} in ${context.repoRoot}`,
    };
  },
});
```

Tools registered via `session.registry.register` will automatically appear in the model-facing tool list and execution will flow through the standard `Session` lifecycle.
