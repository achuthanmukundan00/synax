/**
 * Tool-call parser registry.
 *
 * Maps parser IDs to parser implementations. Supports registration,
 * lookup, listing, and parse dispatch. Designed to mirror vLLM's
 * ToolParserManager but for Synax's TypeScript runtime.
 *
 * Reference: vLLM docs/features/tool_calling.md and
 *   vllm/entrypoints/openai/tool_parsers/ directory.
 */

import type { ToolCallParser, ToolCallParserFactory, ToolCallParserRegistry, ToolCallParseResult } from './types';
import { sanitizeReasoningTags } from './utils';

// ─── Singleton registry ───────────────────────────────────

const parsers = new Map<string, ToolCallParserFactory>();

export const toolCallParserRegistry: ToolCallParserRegistry = {
  register(id: string, factory: ToolCallParserFactory): void {
    const normalized = id.trim().toLowerCase();
    if (!normalized) throw new Error('parser id must not be empty');
    parsers.set(normalized, factory);
  },

  get(id: string): ToolCallParser | undefined {
    const factory = parsers.get(id.trim().toLowerCase());
    return factory?.();
  },

  listIds(): string[] {
    return Array.from(parsers.keys()).sort();
  },

  listParsers(): Array<{ id: string; description: string; modelFamilies: string[] }> {
    return Array.from(parsers.entries())
      .map(([id, factory]) => {
        const parser = factory();
        return { id, description: parser.description, modelFamilies: parser.modelFamilies };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  },

  parse(id: string, content: string): ToolCallParseResult {
    const parser = this.get(id);
    if (!parser) {
      return {
        ok: false,
        parserId: id,
        calls: [],
        content,
        error: `unknown parser: "${id}". Available: ${this.listIds().join(', ')}`,
      };
    }
    const sanitized = sanitizeReasoningTags(content);
    return parser.parse(sanitized);
  },
};

// ─── Convenience exports ──────────────────────────────────

/** Register all built-in parsers. Called once at module load. */
export function registerBuiltinParsers(): void {
  // Imported and registered in index.ts to avoid circular deps
}

/** Get the singleton registry instance. */
export function getToolCallParserRegistry(): ToolCallParserRegistry {
  return toolCallParserRegistry;
}
