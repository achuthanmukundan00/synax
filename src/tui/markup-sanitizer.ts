/**
 * Strip protocol XML markup from reasoning content before display.
 * Prevents raw </think>, <tool_call>, <function=...> tags from
 * leaking into the user-visible thinking output.
 *
 * Safe for streaming: strips complete blocks AND bare tags so
 * cross-chunk blocks are handled when the accumulated body is
 * re-sanitized after each append.
 */
export function stripToolCallMarkup(text: string): string {
  return (
    text
      // Complete <tool_call>...</tool_call> blocks (nested XML inside)
      .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
      // Standalone/open/close <tool_call> tags (handles cross-chunk fragments)
      .replace(/<\/?tool_call\b[^>]*>/gi, '')
      // <function=NAME>...</function> blocks
      .replace(/<function=[^>]*>[\s\S]*?<\/function>/gi, '')
      // Bare <function=NAME> or </function> tags
      .replace(/<\/?function\b[^>]*>/gi, '')
      // <parameter=NAME>...</parameter> blocks
      .replace(/<parameter=[^>]*>[\s\S]*?<\/parameter>/gi, '')
      // Bare <parameter=NAME> or </parameter> tags
      .replace(/<\/?parameter\b[^>]*>/gi, '')
      // Stray <think>, </think>, <thinking>, </thinking>
      .replace(/<\/?think(?:ing)?\b[^>]*>/gi, '')
      // <invoke>, </invoke> tags
      .replace(/<\/?invoke\b[^>]*>/gi, '')
      // Malformed parameter block without closing >:
      // <parameter=path value </parameter  → strip value + tags
      .replace(/<parameter=[^>\s][^>]*?(?:<\/parameter|$)/gi, ' ')
      // Individual malformed protocol tags without closing >:
      // <tool_call, </function, <think, </thinking, etc.
      .replace(/<\/?(?:tool_call|function|parameter|invoke|think(?:ing)?)\b[^>\s]*/gi, ' ')
      // Bare protocol shorthand without angle brackets: =read=path src/foo.ts
      // (handle concatenated calls like path.ts=read=path next.ts via non-greedy value)
      .replace(/=\w+=\w+\s+\S+?(?=\s|$|=\w+=)/gi, ' ')
      // Bare function=read, parameter=path leaked after tag stripping
      .replace(/\b(?:function|parameter)=\w+/gi, ' ')
      // Collapse horizontal whitespace runs (spaces/tabs) but preserve newlines
      .replace(/[ \t]+/g, ' ')
      // Normalize multiple consecutive newlines to at most 2
      .replace(/\n{3,}/g, '\n\n')
  );
}
