/**
 * Canonical types for Synax tool-call parsers.
 *
 * Parsers convert model text output into normalized ParsedToolCall records.
 * Inspired by vLLM's tool-call-parser architecture but implemented natively
 * so Synax does not depend on vLLM runtime normalization.
 */

// ─── Canonical tool call ──────────────────────────────────

export interface ParsedToolCall {
  /** Stable call id, either from model output or deterministically generated. */
  id: string;
  /** Function/tool name. */
  name: string;
  /** Parsed arguments object. */
  arguments: Record<string, unknown>;
  /** Raw source text span (the exact substring that was parsed). */
  rawSource?: string;
  /** Parser id that produced this call. */
  parserId?: string;
  /** Recoverable parse warnings. */
  warnings?: string[];
}

// ─── Parser result ────────────────────────────────────────

export interface ToolCallParseResult {
  /** Whether parsing itself succeeded (even if no calls were found). */
  ok: boolean;
  /** Parser id used. */
  parserId: string;
  /** Parsed calls. This is empty when no calls were detected — that is not an error. */
  calls: ParsedToolCall[];
  /** Non-call content that should remain in the assistant message. */
  content: string;
  /** Errors when ok=false. */
  error?: string;
  /** Recoverable warnings (call-level warnings are on each ParsedToolCall). */
  warnings?: string[];
}

// ─── Parser interface ─────────────────────────────────────

/**
 * A tool-call parser converts raw model text into normalized tool call records.
 *
 * Parsers are stateless single-invocation functions. Streaming buffering
 * is handled by the caller (the provider client), which feeds complete
 * model output to the parser after the stream ends.
 */
export interface ToolCallParser {
  /** Unique parser id, matching vLLM's --tool-call-parser names where practical. */
  readonly id: string;
  /** Human-readable description for config docs. */
  readonly description: string;
  /** Model families this parser is designed for (for docs and auto-detection). */
  readonly modelFamilies: string[];
  /** Parse a complete model response text into canonical calls. */
  parse(content: string): ToolCallParseResult;
}

// ─── Parser factory ───────────────────────────────────────

/**
 * Factory function that creates a parser instance.
 * Matching vLLM's approach, parsers receive a tokenizer only when needed
 * (primarily for parsers that need to decode token IDs). For Synax's
 * text-based parsing, most parsers use the default no-op factory.
 */
export type ToolCallParserFactory = () => ToolCallParser;

// ─── Registry ─────────────────────────────────────────────

export interface ToolCallParserRegistry {
  /** Register a parser factory under a given id. */
  register(id: string, factory: ToolCallParserFactory): void;
  /** Get a parser by id. Returns undefined if not registered. */
  get(id: string): ToolCallParser | undefined;
  /** List all registered parser ids. */
  listIds(): string[];
  /** List all registered parsers with their descriptions. */
  listParsers(): Array<{ id: string; description: string; modelFamilies: string[] }>;
  /** Parse content using the parser registered under `id`. */
  parse(id: string, content: string): ToolCallParseResult;
}

// ─── Auto-detection ───────────────────────────────────────

/**
 * Conservative auto-detection. Inspects the model id string for substrings
 * matching known model families. Returns undefined when uncertain.
 *
 * Config override always takes priority over auto-detection.
 */
export function detectParserId(modelId: string): string | undefined {
  const lower = modelId.toLowerCase();

  // Order matters: more specific patterns first.
  const patterns: Array<{ pattern: RegExp; parser: string }> = [
    // XML/tag-based families
    { pattern: /\bqwen3[-.]?coder\b/i, parser: 'qwen3_xml' },
    { pattern: /\bqwen3\.6\b/i, parser: 'qwen3_xml' },
    { pattern: /\bqwen3\.5\b/i, parser: 'qwen3_xml' },
    { pattern: /\bqwen3\b/i, parser: 'qwen3_xml' },
    { pattern: /\bqwen2\.5\b/i, parser: 'hermes' }, // Qwen2.5 uses Hermes-style
    // No broad /\bqwen\b/i catch-all — Qwen3.X / Qwen3-Coder / Qwen3 are matched above.

    // Hermes family
    { pattern: /\bhermes\b/i, parser: 'hermes' },
    { pattern: /\bnous\b/i, parser: 'hermes' },
    { pattern: /openhermes/i, parser: 'hermes' },

    // Llama 3/4 JSON
    { pattern: /\bllama-?4\b/i, parser: 'llama4_pythonic' },
    { pattern: /\bllama-?3\.?[23]\b/i, parser: 'llama3_json' },
    { pattern: /\bllama-?3\b/i, parser: 'llama3_json' },
    { pattern: /meta-llama/i, parser: 'llama3_json' },

    // DeepSeek
    { pattern: /deepseek-?v3\.1/i, parser: 'deepseek_v31' },
    { pattern: /deepseek-?v3/i, parser: 'deepseek_v3' },
    { pattern: /deepseek-?r1/i, parser: 'deepseek_v3' },
    { pattern: /deepseek/i, parser: 'deepseek_v3' },

    // Mistral
    { pattern: /\bmistral\b/i, parser: 'mistral' },
    { pattern: /mixtral/i, parser: 'mistral' },

    // xLAM
    { pattern: /\bxlam\b/i, parser: 'xlam' },

    // Granite
    { pattern: /\bgranite-?4\b/i, parser: 'granite4' },
    { pattern: /\bgranite-?20b-fc\b/i, parser: 'granite-20b-fc' },
    { pattern: /\bgranite\b/i, parser: 'granite' },

    // InternLM
    { pattern: /\binternlm/i, parser: 'internlm' },

    // FunctionGemma
    { pattern: /\bfunctiongemma\b/i, parser: 'functiongemma' },
    { pattern: /\bgemma-?2.*function/i, parser: 'functiongemma' },

    // OLMo3
    { pattern: /\bolmo[e3]/i, parser: 'olmo3' },

    // GLM family
    { pattern: /\bglm-?4\.7\b/i, parser: 'glm47' },
    { pattern: /\bglm-?4\.5\b/i, parser: 'glm45' },
    { pattern: /\bglm-?4\b/i, parser: 'glm45' },
    { pattern: /\bglm\b/i, parser: 'glm45' },

    // Step family
    { pattern: /\bstep-?3\.5\b/i, parser: 'step3p5' },
    { pattern: /\bstep-?3\b/i, parser: 'step3' },
    // No broad /\bstep\b/i catch-all — "step" is a common word in unrelated model names.

    // Kimi
    { pattern: /\bkimi[-_]?k2\b/i, parser: 'kimi_k2' },
    { pattern: /\bkimi\b/i, parser: 'kimi_k2' },

    // Hunyuan
    { pattern: /\bhunyuan[-_]?a13b\b/i, parser: 'hunyuan_a13b' },
    { pattern: /\bhunyuan\b/i, parser: 'hunyuan_a13b' },

    // LongCat
    { pattern: /\blongcat\b/i, parser: 'longcat' },

    // Jamba
    { pattern: /\bjamba\b/i, parser: 'jamba' },

    // MiniMax
    { pattern: /\bminimax\b/i, parser: 'minimax' },

    // GigaChat
    { pattern: /\bgigachat\b/i, parser: 'gigachat3' },

    // Pythonic (Llama 4, etc.)
    { pattern: /\bllama-?4\b/i, parser: 'llama4_pythonic' },
  ];

  for (const { pattern, parser } of patterns) {
    if (pattern.test(lower)) return parser;
  }

  return undefined;
}
