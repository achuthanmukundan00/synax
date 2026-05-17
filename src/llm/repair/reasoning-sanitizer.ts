/**
 * Reasoning sanitizer — strips model thinking/reasoning text from output.
 *
 * Local models frequently leak reasoning text into the visible output stream.
 * This module provides sanitization for:
 * - `<think>...</think>` blocks (Qwen, DeepSeek)
 * - `<thinking>...</thinking>` blocks (Frontier-style, various)
 * - ` response/` fenced code blocks (DeepSeek)
 * - DeepSeek reasoning_content leakage into content field
 *
 * Returns sanitized output with a flag indicating whether any reasoning was removed.
 */

export interface SanitizeResult {
  content: string;
  removedReasoning: boolean;
}

/**
 * Sanitize model output by removing reasoning/thinking text.
 *
 * Handles three patterns:
 * 1. `<think>...</think>` — Qwen-style reasoning blocks (with possible attributes)
 * 2. `<thinking>...</thinking>` — More explicit reasoning markers
 * 3. ```response / ```text / ``` reasoning blocks — DeepSeek-style
 *
 * Returns sanitized content and a flag indicating whether anything was removed.
 */
export function sanitizeReasoning(content: string): SanitizeResult {
  let sanitized = content;
  let removedReasoning = false;

  // Pattern 1: <think>...</think> blocks (handle with attributes, multiline, case-insensitive)
  const thinkRegex = /<think\b[^>]*>[\s\S]*?<\/think>/gi;
  if (thinkRegex.test(sanitized)) {
    sanitized = sanitized.replace(thinkRegex, '');
    removedReasoning = true;
  }

  // Pattern 2: <thinking>...</thinking> blocks
  const thinkingRegex = /<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi;
  if (thinkingRegex.test(sanitized)) {
    sanitized = sanitized.replace(thinkingRegex, '');
    removedReasoning = true;
  }

  // Pattern 3: DeepSeek-style ```response / ```text / ```thinking / ```assistant blocks
  // These are fenced code blocks that contain reasoning or redundant output
  const fencedResponseRegex = /```\s*(?:response|assistant_text|thinking|reasoning)[\s\S]*?```/gi;
  if (fencedResponseRegex.test(sanitized)) {
    sanitized = sanitized.replace(fencedResponseRegex, '');
    removedReasoning = true;
  }

  // Pattern 4: Self-closing <think/> or <thinking/> tags
  const selfClosingRegex = /<think(?:ing)?\s*\/>/gi;
  if (selfClosingRegex.test(sanitized)) {
    sanitized = sanitized.replace(selfClosingRegex, '');
    removedReasoning = true;
  }

  // Pattern 5: Opening <think> without closing tag (truncated reasoning)
  // If we see <think or <thinking without a matching close, trim from there
  const openThinkIdx = sanitized.search(/<think(?:ing)?\b/i);
  if (openThinkIdx !== -1) {
    // Check if there's a matching close tag after it
    const afterOpen = sanitized.slice(openThinkIdx);
    const hasClose = /<\/think(?:ing)?>/i.test(afterOpen);
    if (!hasClose) {
      // Truncated thinking tag — remove from here to end
      sanitized = sanitized.slice(0, openThinkIdx);
      removedReasoning = true;
    } else {
      // Has close tag, but the regex above should have caught it.
      // Try a more aggressive cleanup
      const thinkPattern = /<think(?:ing)?\b[^>]*>[\s\S]*?<\/think(?:ing)?>/gi;
      if (thinkPattern.test(sanitized)) {
        sanitized = sanitized.replace(thinkPattern, '');
        removedReasoning = true;
      }
    }
  }

  // Pattern 6: Stray closing tags from truncated/streamed reasoning blocks.
  // Some local models emit only the visible answer plus a dangling </think>.
  const strayClosingRegex = /<\/think(?:ing)?>/gi;
  if (strayClosingRegex.test(sanitized)) {
    sanitized = sanitized.replace(strayClosingRegex, '');
    removedReasoning = true;
  }

  // Pattern 7: Remove leading/trailing whitespace introduced by removals
  // Also collapse consecutive blank lines
  sanitized = sanitized.replace(/\n{3,}/g, '\n\n').trim();

  return { content: sanitized, removedReasoning };
}
