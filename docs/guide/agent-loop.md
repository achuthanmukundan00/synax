# Agent Loop And Tools

Synax uses a bounded model-tool loop:

1. Add the user task to the conversation.
2. Send model-facing tools to the provider.
3. Execute requested tool calls through local guardrails.
4. Append compact tool results.
5. Stop when the model returns a normal assistant answer or a configured limit is reached.
6. Run configured verification for `synax run` when available.

## Tool Surface

The model-facing tool names are intentionally small:

| Tool    | Purpose                                               |
| ------- | ----------------------------------------------------- |
| `read`  | List files, read a bounded file range, or search text |
| `edit`  | Exact `replace_in_file` edit                          |
| `write` | Create a new repo-local text file                     |
| `bash`  | Run terminal commands, including git and verification |

Internally, read calls map to more specific tools such as `list_files`, `read_file_range`, and `search_text`.

## Editing Rules

`edit` uses exact replacement. The file must already have been inspected, and the old string must match exactly once.

`write` creates new files only. It fails if the target path already exists.

Unsafe paths, generated directories, environment files, and path traversal are rejected by file policy.

## Tool-Call Compatibility

Synax sends standard OpenAI-compatible `tools` with automatic tool choice. It accepts standard `message.tool_calls` and local-model fallback text blocks such as:

```txt
<tool_call>{"name":"read","arguments":{"path":"src/cli.ts"}}</tool_call>
```

This makes Synax usable with local Qwen-style tool-call formats that some Relay-backed models emit.

Tool-call `arguments` may be JSON objects or stringified JSON objects. Explicit `<tool_call>` blocks with malformed JSON are rejected before execution and surface as a `model_error`. Generic fenced JSON is only interpreted when it parses cleanly; malformed fenced JSON is ignored.

## Loop Limits

Defaults:

```toml
[agent]
context_budget_tokens = 131072
max_tool_calls = 192
```

Synax keeps the model loop running until the model completes, the user stops it, or a guardrail such as context-window or tool-call limits blocks further progress.
