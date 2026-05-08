/**
 * Synax native tool-call parsers — index and registration.
 *
 * Registers all vLLM-equivalent tool-call parsers into the singleton registry.
 * Import this module once at startup to enable all parsers.
 *
 * Parser IDs match vLLM's --tool-call-parser values where practical.
 * Aliases are registered only for backward compatibility (e.g., 'qwen3_coder' → 'qwen3_xml').
 */

import { toolCallParserRegistry } from './registry';
import { createQwen3XmlParser } from './qwen3-xml';
import { createHermesParser } from './hermes';
import { createLlama3JsonParser } from './llama3-json';
import { createPythonicParser, createLlama4PythonicParser } from './pythonic';
import { createMistralParser } from './mistral';
import { createDeepseekV3Parser, createDeepseekV31Parser } from './deepseek';
import { createXlamParser } from './xlam';
import {
  createGraniteParser,
  createGranite4Parser,
  createGranite20bFcParser,
  createInternlmParser,
  createFunctionGemmaParser,
  createOlmo3Parser,
  createJambaParser,
  createMinimaxParser,
  createKimiK2Parser,
  createHunyuanA13bParser,
  createLongcatParser,
  createGigachat3Parser,
  createOpenaiPassthroughParser,
} from './json-in-tags';
import { createGlm45Parser, createGlm47Parser, createStep3Parser, createStep3p5Parser } from './glm-step';
import { createGenericParser } from './generic';

// ─── Registration ─────────────────────────────────────────

let registered = false;

export function ensureParsersRegistered(): void {
  if (registered) return;
  registered = true;

  // XML/tag-based parsers (highest priority for local models)
  toolCallParserRegistry.register('qwen3_xml', createQwen3XmlParser);
  toolCallParserRegistry.register('qwen3_coder', createQwen3XmlParser); // backward compat alias
  toolCallParserRegistry.register('hermes', createHermesParser);
  toolCallParserRegistry.register('step3', createStep3Parser);
  toolCallParserRegistry.register('step3p5', createStep3p5Parser);
  toolCallParserRegistry.register('functiongemma', createFunctionGemmaParser);
  toolCallParserRegistry.register('olmo3', createOlmo3Parser);
  toolCallParserRegistry.register('glm45', createGlm45Parser);
  toolCallParserRegistry.register('glm47', createGlm47Parser);
  toolCallParserRegistry.register('gigachat3', createGigachat3Parser);

  // JSON-based parsers
  toolCallParserRegistry.register('llama3_json', createLlama3JsonParser);
  toolCallParserRegistry.register('mistral', createMistralParser);
  toolCallParserRegistry.register('xlam', createXlamParser);
  toolCallParserRegistry.register('granite', createGraniteParser);
  toolCallParserRegistry.register('granite4', createGranite4Parser);
  toolCallParserRegistry.register('granite-20b-fc', createGranite20bFcParser);
  toolCallParserRegistry.register('internlm', createInternlmParser);
  toolCallParserRegistry.register('jamba', createJambaParser);
  toolCallParserRegistry.register('minimax', createMinimaxParser);
  toolCallParserRegistry.register('kimi_k2', createKimiK2Parser);
  toolCallParserRegistry.register('hunyuan_a13b', createHunyuanA13bParser);
  toolCallParserRegistry.register('longcat', createLongcatParser);
  toolCallParserRegistry.register('openai', createOpenaiPassthroughParser);

  // Pythonic parsers
  toolCallParserRegistry.register('pythonic', createPythonicParser);
  toolCallParserRegistry.register('llama4_pythonic', createLlama4PythonicParser);

  // DeepSeek parsers
  toolCallParserRegistry.register('deepseek_v3', createDeepseekV3Parser);
  toolCallParserRegistry.register('deepseek_v31', createDeepseekV31Parser);

  // Generic fallback
  toolCallParserRegistry.register('generic', createGenericParser);
}

// ─── Re-exports ───────────────────────────────────────────

export { toolCallParserRegistry } from './registry';
export { getToolCallParserRegistry } from './registry';
export { detectParserId } from './types';
export type {
  ParsedToolCall,
  ToolCallParseResult,
  ToolCallParser,
  ToolCallParserFactory,
  ToolCallParserRegistry,
} from './types';

export {
  sanitizeReasoningTags,
  safeJsonParse,
  coerceValue,
  generateCallId,
  resetCallIdCounter,
  makeCall,
  parsePythonicArgs,
  extractDelimitedBlocks,
  extractNonToolContent,
} from './utils';
