/**
 * XML repair — bounded auto-recovery for Qwen-style XML tool calls.
 *
 * Qwen-family models emit `<tool_call>` blocks in XML format. Local
 * models frequently produce:
 * - Unclosed `<tool_call>` tags
 * - Leaked `<thinking>` / `<think>` tags inside tool calls
 * - Mixed XML + text content where thinking bleeds into tool blocks
 * - Nested `<tool_call>` with missing closing function tags
 *
 * Each repair is recorded in `fixes[]` for debugging. Returns `null` when
 * the input is unrepairable.
 */

export interface RepairResult {
  repaired: string;
  fixes: string[];
}

/**
 * Attempt to repair malformed XML tool-call text from a local model.
 *
 * Repairs applied:
 * 1. Strip leaked reasoning tags inside tool-call blocks
 * 2. Close unclosed `<tool_call>` tags
 * 3. Close unclosed `<function=...>` tags
 * 4. Close unclosed `<parameter=...>` tags
 * 5. Strip stray text between tool-call segments
 *
 * Returns `null` if the string is unrepairable (empty or garbage).
 */
export function repairXml(raw: string): RepairResult | null {
  const fixes: string[] = [];
  let working = raw.trim();

  if (!working) return null;
  if (!containsXmlTags(working)) return null;

  // Step 1: Strip leaked reasoning tags
  const { cleaned, hadReasoning } = stripReasoningFromXml(working);
  if (hadReasoning) {
    fixes.push('stripped reasoning tags inside tool blocks');
    working = cleaned;
  }

  // Step 2: Balance <tool_call> ... </tool_call> pairs
  const toolBalanced = balanceToolCallTags(working);
  if (toolBalanced !== working) {
    fixes.push('balanced <tool_call> tags');
    working = toolBalanced;
  }

  // Step 3: Balance <function=...> ... </function> pairs
  const funcBalanced = balanceFunctionTags(working);
  if (funcBalanced !== working) {
    fixes.push('balanced <function> tags');
    working = funcBalanced;
  }

  // Step 4: Balance <parameter=...> ... </parameter> pairs
  const paramBalanced = balanceParameterTags(working);
  if (paramBalanced !== working) {
    fixes.push('balanced <parameter> tags');
    working = paramBalanced;
  }

  // Step 5: Extract only tool-call blocks if there's mixed content
  const extracted = extractToolCallBlocks(working);
  if (extracted !== working) {
    fixes.push('extracted tool-call blocks from mixed content');
    working = extracted;
  }

  // Step 6: Wrap bare function names inside <tool_call> blocks that lack <function=...>
  // Local models sometimes emit: <tool_call>read<parameter=...>...</parameter></tool_call>
  // instead of: <tool_call><function=read>...</function></tool_call>
  const wrapped = wrapBareFunctionNames(working);
  if (wrapped !== working) {
    fixes.push('wrapped bare function name in <function=...> tags');
    working = wrapped;
  }

  if (!working) return null;

  return { repaired: working, fixes };
}

// ─── Internal helpers ─────────────────────────────────────

function containsXmlTags(text: string): boolean {
  return /<tool_call/i.test(text) || /<\/tool_call>/i.test(text);
}

/**
 * Strip <think>...</think> and <thinking>...</thinking> blocks
 * that leaked into tool-call XML.
 */
function stripReasoningFromXml(text: string): { cleaned: string; hadReasoning: boolean } {
  let cleaned = text;
  let hadReasoning = false;

  // Remove thinking blocks (handle case-insensitive, multiline)
  const thinkingRegex = /<think\b[^>]*>[\s\S]*?<\/think>/gi;
  const thinkingRegex2 = /<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi;

  if (thinkingRegex.test(cleaned) || thinkingRegex2.test(cleaned)) {
    hadReasoning = true;
    cleaned = cleaned.replace(thinkingRegex, '').replace(thinkingRegex2, '');
  }

  // Also strip DeepSeek-style ` response` blocks if present
  const responseBlockRegex = /```\s*response\s*[\s\S]*?```/gi;
  if (responseBlockRegex.test(cleaned)) {
    hadReasoning = true;
    cleaned = cleaned.replace(responseBlockRegex, '');
  }

  return { cleaned: cleaned.trim(), hadReasoning };
}

/**
 * Balance <tool_call> ... </tool_call> pairs.
 * Adds missing closing tags or strips unclosed opening tags.
 */
function balanceToolCallTags(text: string): string {
  const openRegex = /<tool_call>/gi;
  const closeRegex = /<\/tool_call>/gi;

  const opens = (text.match(openRegex) || []).length;
  const closes = (text.match(closeRegex) || []).length;

  // Reset lastIndex after global regex
  openRegex.lastIndex = 0;
  closeRegex.lastIndex = 0;

  if (opens === closes) return text;

  if (opens > closes) {
    // Add missing closing tags
    const missing = opens - closes;
    return text + '</tool_call>\n'.repeat(missing);
  }

  // More closing than opening — strip extra closing tags from the end
  const extra = closes - opens;
  let result = text;
  for (let i = 0; i < extra; i++) {
    const lastClose = result.lastIndexOf('</tool_call>');
    if (lastClose === -1) break;
    const after = result.slice(lastClose + '</tool_call>'.length).trim();
    result = result.slice(0, lastClose) + (after ? after : '');
  }
  return result;
}

/**
 * Balance <function=NAME> ... </function> pairs.
 * Inserts missing closing tags before the enclosing </tool_call> when possible.
 */
function balanceFunctionTags(text: string): string {
  const openRegex = /<function=[^>]+>/gi;
  const closeRegex = /<\/function>/gi;

  const opens = (text.match(openRegex) || []).length;
  const closes = (text.match(closeRegex) || []).length;

  openRegex.lastIndex = 0;
  closeRegex.lastIndex = 0;

  if (opens === closes) return text;

  if (opens > closes) {
    // Add missing closing tags inside the last tool_call block
    const missing = opens - closes;
    let result = text;
    // Insert </function> before each </tool_call> that needs it
    const toolCloseIdx = result.lastIndexOf('</tool_call>');
    if (toolCloseIdx !== -1) {
      const before = result.slice(0, toolCloseIdx);
      const after = result.slice(toolCloseIdx);
      result = before + '\n</function>'.repeat(missing) + '\n' + after;
    } else {
      result += '\n</function>'.repeat(missing);
    }
    return result;
  }

  // More closing than opening — strip extra closing tags
  const extra = closes - opens;
  let result = text;
  for (let i = 0; i < extra; i++) {
    const lastClose = result.lastIndexOf('</function>');
    if (lastClose === -1) break;
    const after = result.slice(lastClose + '</function>'.length).trim();
    result = result.slice(0, lastClose) + (after ? after : '');
  }
  return result;
}

/**
 * Balance <parameter=NAME> ... </parameter> pairs.
 */
function balanceParameterTags(text: string): string {
  const openRegex = /<parameter=[^>]+>/gi;
  const closeRegex = /<\/parameter>/gi;

  const opens = (text.match(openRegex) || []).length;
  const closes = (text.match(closeRegex) || []).length;

  openRegex.lastIndex = 0;
  closeRegex.lastIndex = 0;

  if (opens === closes) return text;

  if (opens > closes) {
    // Add missing closing tags
    const missing = opens - closes;
    let result = text;
    // Insert </parameter> before enclosing close tags when possible
    const funcCloseIdx = result.lastIndexOf('</function>');
    const toolCloseIdx = result.lastIndexOf('</tool_call>');
    const insertIdx = funcCloseIdx !== -1 ? funcCloseIdx : toolCloseIdx !== -1 ? toolCloseIdx : result.length;
    if (insertIdx < result.length) {
      const before = result.slice(0, insertIdx);
      const after = result.slice(insertIdx);
      result = before + '\n</parameter>'.repeat(missing) + '\n' + after;
    } else {
      result += '\n</parameter>'.repeat(missing);
    }
    return result;
  }

  // More closing than opening — strip extras
  const extra = closes - opens;
  let result = text;
  for (let i = 0; i < extra; i++) {
    const lastClose = result.lastIndexOf('</parameter>');
    if (lastClose === -1) break;
    const after = result.slice(lastClose + '</parameter>'.length).trim();
    result = result.slice(0, lastClose) + (after ? after : '');
  }
  return result;
}

/**
 * Wrap bare function names that appear at the start of <tool_call> blocks
 * without the required <function=NAME> wrapper.
 *
 * Example input:
 *   <tool_call>\nread\n<parameter=path>foo</parameter></tool_call>
 *
 * Example output:
 *   <tool_call>\n<function=read>\n<parameter=path>foo</parameter>\n</function>\n</tool_call>
 */
function wrapBareFunctionNames(text: string): string {
  // Only process if there are blocks that might need fixing
  if (!/<tool_call>/i.test(text)) return text;

  // Check if there are any blocks WITHOUT <function= already
  const hasFunctionRegex = /<function=[^>]+>/i;
  let hasBlockNeedingFix = false;

  // Quick scan: any tool_call block that lacks <function=...>
  const blockRegex = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  for (const match of text.matchAll(blockRegex)) {
    const inner = match[1];
    if (inner && !hasFunctionRegex.test(inner)) {
      hasBlockNeedingFix = true;
      break;
    }
  }
  if (!hasBlockNeedingFix) return text;

  // Rebuild: wrap bare function names in blocks lacking <function=...>
  let result = '';
  let lastIndex = 0;
  blockRegex.lastIndex = 0;

  for (const match of text.matchAll(blockRegex)) {
    const before = text.slice(lastIndex, match.index);
    result += before;
    lastIndex = match.index + match[0].length;

    const inner = match[1];
    if (!inner) {
      result += match[0];
      continue;
    }

    // Already has <function= — leave unchanged
    if (hasFunctionRegex.test(inner)) {
      result += match[0];
      continue;
    }

    // Try to find a bare function name at the start of the inner content
    const trimmed = inner.trimStart();
    const fnMatch = trimmed.match(/^([a-zA-Z_][\w.]*)\s*(?=[\n<]|$)/);
    if (!fnMatch || !fnMatch[1]) {
      // Can't find a function name — leave unchanged (parser will fail, but
      // the recovery recipe can still try a retry-nudge)
      result += match[0];
      continue;
    }

    const fnName = fnMatch[1];
    const afterName = trimmed.slice(fnName.length);

    // Reconstruct: <tool_call>\n<function=NAME>REST\n</function>\n</tool_call>
    result += `<tool_call>\n<function=${fnName}>${afterName}\n</function>\n</tool_call>`;
  }

  // Append any trailing text after the last block
  result += text.slice(lastIndex);

  return result;
}

/**
 * Extract only the tool-call blocks from text that may have mixed content.
 * Returns consecutive <tool_call>...</tool_call> blocks.
 */
function extractToolCallBlocks(text: string): string {
  const blocks: string[] = [];
  const regex = /<tool_call>([\s\S]*?)<\/tool_call>/gi;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const inner = match[1]?.trim();
    if (inner) {
      blocks.push(`<tool_call>\n${inner}\n</tool_call>`);
    }
  }

  return blocks.length > 0 ? blocks.join('\n') : text;
}
