import { createInspectionLedger, InspectionLedger } from './ledger';
import { createInspectionTools } from './tools';
import { ToolContext, ToolDefinition, ToolRegistry, ToolResult } from './types';
import { GeneratedContentStore } from './generated-content';

export interface ToolRegistryOptions {
  repoRoot: string;
  ledger?: InspectionLedger;
  generatedContent?: GeneratedContentStore;
}

export function createToolRegistry(options: ToolRegistryOptions): ToolRegistry {
  const ledger = options.ledger ?? createInspectionLedger();
  const context: ToolContext = {
    repoRoot: options.repoRoot,
    ledger,
    generatedContent: options.generatedContent,
    lastUserMessage: undefined,
  };
  const tools = createInspectionTools();
  const byName = new Map<string, ToolDefinition>(tools.map((tool) => [tool.name, tool]));

  return {
    list(): ToolDefinition[] {
      return [...tools];
    },

    get(name: string): ToolDefinition | undefined {
      return byName.get(name);
    },

    register(definition: ToolDefinition): void {
      if (byName.has(definition.name)) {
        throw new Error(`Tool already registered: ${definition.name}`);
      }
      byName.set(definition.name, definition);
      tools.push(definition);
    },

    setLastUserMessage(message: string): void {
      context.lastUserMessage = message;
    },

    async execute(name: string, input: unknown): Promise<ToolResult> {
      let tool = byName.get(name);
      if (!tool) {
        // Normalize camelCase → snake_case for providers that auto-convert function names
        const normalized = name.replace(/([A-Z])/g, '_$1').toLowerCase();
        tool = byName.get(normalized);
      }
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
