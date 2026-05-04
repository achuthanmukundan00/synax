import { createInspectionLedger, InspectionLedger } from './ledger';
import { createInspectionTools } from './tools';
import { ToolDefinition, ToolRegistry, ToolResult } from './types';

export interface ToolRegistryOptions {
  repoRoot: string;
  ledger?: InspectionLedger;
}

export function createToolRegistry(options: ToolRegistryOptions): ToolRegistry {
  const ledger = options.ledger ?? createInspectionLedger();
  const context = { repoRoot: options.repoRoot, ledger };
  const tools = createInspectionTools();
  const byName = new Map<string, ToolDefinition>(tools.map((tool) => [tool.name, tool]));

  return {
    list(): ToolDefinition[] {
      return [...tools];
    },

    get(name: string): ToolDefinition | undefined {
      return byName.get(name);
    },

    async execute(name: string, input: unknown): Promise<ToolResult> {
      const tool = byName.get(name);
      if (!tool) {
        return { success: false, toolName: name, error: `unknown tool: ${name}` };
      }

      if (!isPlainInput(input)) {
        return { success: false, toolName: name, error: 'input must be an object' };
      }

      return tool.execute(input, context);
    },
  };
}

function isPlainInput(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
