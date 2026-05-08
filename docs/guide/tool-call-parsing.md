# Tool-Call Parsing

Synax includes native tool-call parsers for every model family supported by vLLM's `--tool-call-parser` flag. This means Synax can parse raw model tool-call output without requiring vLLM to normalize it first.

## Why Native Parsing?

Local models often don't emit clean OpenAI-format `tool_calls`. Instead, they emit:

- XML/tag-delimited blocks (`<tool_call>...</tool_call>`)
- Pythonic function-call syntax (`func(arg="value")`)
- Special-token-delimited formats (`<|python_tag|>`, `[TOOL_CALLS]`)
- Family-specific markup (`<function=name>`, `<function_calls>`)

Synax parses all of these formats natively, so you don't need vLLM runtime normalization.

## Configuration

### Per-Provider Parser

Set `tool_call_parser` in your provider config:

```toml
[providers.relay]
id = "relay"
model = "Qwen3.6-35B-A3B"
tool_call_parser = "qwen3_xml"
```

### Auto-Detection

If you don't set `tool_call_parser`, Synax auto-detects the parser from your model name:

| Model Family | Auto-Detected Parser |
|---|---|
| Qwen3, Qwen3-Coder, Qwen3.5, Qwen3.6 | `qwen3_xml` |
| Qwen2.5 | `hermes` |
| Hermes, NousResearch, OpenHermes | `hermes` |
| Llama 3 / 3.1 / 3.2 / 3.3 | `llama3_json` |
| Llama 4 | `llama4_pythonic` |
| DeepSeek V3 / Chat / R1 | `deepseek_v3` |
| DeepSeek V3.1 | `deepseek_v31` |
| Mistral, Mixtral | `mistral` |
| xLAM | `xlam` |
| Granite / Granite 3 | `granite` |
| Granite 4 | `granite4` |
| Granite 20B FC | `granite-20b-fc` |
| InternLM | `internlm` |
| FunctionGemma | `functiongemma` |
| OLMo3 / OLMoE | `olmo3` |
| GLM-4 / GLM-4.5 | `glm45` |
| GLM-4.7 | `glm47` |
| Step 3 | `step3` |
| Step 3.5 | `step3p5` |
| Kimi K2 | `kimi_k2` |
| Hunyuan A13B | `hunyuan_a13b` |
| LongCat | `longcat` |
| Jamba | `jamba` |
| MiniMax | `minimax` |
| GigaChat 3 | `gigachat3` |

### Explicit Override

```toml
[providers.custom]
id = "custom"
base_url = "http://127.0.0.1:1234/v1"
model = "my-model"
tool_call_parser = "hermes"
```

### Disabling Content Parsing

To rely only on OpenAI-format `tool_calls` from the API (no content parsing):

```toml
tool_call_parser = "openai"
```

## Supported Parsers

### XML/Tag-Based

| Parser ID | Format | Example Models |
|---|---|---|
| `qwen3_xml` | `<tool_call><function=name><parameter=key>val</parameter></function></tool_call>` | Qwen3, Qwen3-Coder |
| `hermes` | `<tool_call>{"name":"...","arguments":{...}}</tool_call>` | Hermes, Qwen2.5 |
| `olmo3` | `<function_calls><function_call>{...}</function_call></function_calls>` | OLMo3 |
| `functiongemma` | `<tool_call>{"name":"...","arguments":{...}}</tool_call>` | FunctionGemma |
| `gigachat3` | `<function=name>{"key":"value"}</function>` | GigaChat 3 |
| `step3` | `<tool_call>` or `<function_call>` blocks | Step 3 |
| `step3p5` | `<tool_call>` or `<function_call>` blocks | Step 3.5 |

### JSON-Based

| Parser ID | Format | Example Models |
|---|---|---|
| `llama3_json` | `<\|python_tag\|>{"name":"...","parameters":{...}}` | Llama 3.x |
| `mistral` | `[TOOL_CALLS][{"name":"...","arguments":{...}}]` | Mistral, Mixtral |
| `xlam` | `<tool_call>{"name":"...","arguments":{...}}</tool_call>` or bare fn+JSON | xLAM |
| `granite` | `<tool_call>{"name":"...","arguments":{...}}</tool_call>` | Granite 3 |
| `granite4` | `<tool_call>{"name":"...","arguments":{...}}</tool_call>` | Granite 4 |
| `granite-20b-fc` | `<tool_call>{"name":"...","arguments":{...}}</tool_call>` | Granite 20B FC |
| `internlm` | `<tool_call>{"name":"...","arguments":{...}}</tool_call>` | InternLM |
| `jamba` | `<tool_call>{"name":"...","arguments":{...}}</tool_call>` | Jamba |
| `minimax` | `<tool_call>{"name":"...","arguments":{...}}</tool_call>` | MiniMax |
| `kimi_k2` | `<tool_call>{"name":"...","arguments":{...}}</tool_call>` | Kimi K2 |
| `hunyuan_a13b` | `<tool_call>{"name":"...","arguments":{...}}</tool_call>` | Hunyuan A13B |
| `longcat` | `<tool_call>{"name":"...","arguments":{...}}</tool_call>` | LongCat |
| `deepseek_v3` | `<tool_call>{"name":"...","arguments":{...}}</tool_call>` | DeepSeek V3, R1 |
| `deepseek_v31` | Same as V3 with special token variant | DeepSeek V3.1 |
| `glm45` | `<\|tool_call\|>{"name":"...","arguments":{...}}` or Hermes fallback | GLM-4.5 |
| `glm47` | Same as glm45 | GLM-4.7 |

### Pythonic

| Parser ID | Format | Example Models |
|---|---|---|
| `pythonic` | `func(key="val", ...)` or `[func(...), func(...)]` | Pythonic-capable models |
| `llama4_pythonic` | `<\|python_tag\|>func(key="val")` | Llama 4 |

### Passthrough

| Parser ID | Behavior |
|---|---|
| `openai` | No text parsing; uses API-returned `tool_calls` only |

### Generic Fallback

| Parser ID | Behavior |
|---|---|
| `generic` | Multi-strategy: tries Hermes-style, fenced JSON, and bare JSON |

## Format Details

### Qwen3 XML (`qwen3_xml`)

```
<tool_call>
<function=get_weather>
<parameter=location>San Francisco</parameter>
<parameter=unit>celsius</parameter>
</function>
</tool_call>
```

Each `<parameter>` value is coerced: `true`/`false` → boolean, `null` → null, numbers → Number, JSON objects/arrays → parsed JSON. Unknown values stay as strings.

### Hermes (`hermes`)

```
<tool_call>
{"name": "get_weather", "arguments": {"location": "SF", "unit": "celsius"}}
</tool_call>
```

Each `<tool_call>` block contains a single JSON object. Supports `name`/`tool_name`/`function` for function name, and `arguments`/`parameters`/`input` for arguments (object or JSON-string).

### Llama 3 JSON (`llama3_json`)

```
<|python_tag|>{"name": "get_weather", "parameters": {"location": "SF"}}
```

Uses `<|python_tag|>` prefix. May include `<|start_header_id|>assistant<|end_header_id|>` and `<|eot_id|>` tokens which are stripped.

### Pythonic (`pythonic`, `llama4_pythonic`)

```python
get_weather(location="San Francisco", unit="celsius")
```

```python
[get_weather(city="SF"), get_weather(city="Seattle")]
```

Safe tokenizer — no `eval()` used. Supports parallel calls (lists), booleans (`True`/`False`), `None`, numbers, and quoted strings.

### Mistral (`mistral`)

```
[TOOL_CALLS][{"name": "get_weather", "arguments": {"location": "SF"}}]
```

### OLMo3 (`olmo3`)

```
<function_calls>
<function_call>
{"name": "get_weather", "arguments": {"location": "SF"}}
</function_call>
</function_calls>
```

## Troubleshooting

### Raw `<tool_call>` Markup in Transcript

If you see `<tool_call>...</tool_call>` markup in the assistant output instead of actual tool executions:

1. **Wrong parser**: Check your `tool_call_parser` config. Use auto-detection or set it explicitly.
2. **Model not formatting correctly**: Some models need a specific chat template. Check vLLM docs for recommended `--chat-template` per model.
3. **Malformed output**: The model may be emitting corrupted tool calls. Enable verbose logging to see raw output.

### Parser Not Found

If you see `unknown parser: "xyz"`:

```bash
synax inspect --parsers
```

This lists all available parsers and their model families.

### Parser Produces No Calls

- The `openai` parser is a passthrough and never parses text.
- The `mistral` parser requires `[TOOL_CALLS]` prefix.
- The `llama3_json` parser requires `<|python_tag|>` prefix.
- Use debug mode to see the raw model output and verify format.

## Native Parsing vs vLLM Normalization

Synax can work in two modes:

1. **Native parsing** (default): Synax parses raw model text output using the configured parser. The provider sees the raw content. Tool calls are extracted by Synax.

2. **vLLM normalization**: If your vLLM server is configured with `--enable-auto-tool-choice --tool-call-parser <parser>`, vLLM normalizes tool calls into OpenAI-format `tool_calls` in the API response. Synax consumes these natively without needing text parsing.

Both modes work. Native parsing is recommended for local providers (Relay, llama.cpp) that don't run the full vLLM tool-call normalization pipeline.

## Limitations

- **Not schema-constrained**: Tool-call parsing is post-hoc text extraction. Model output can still be malformed.
- **No content parsing**: Text in the model output that looks like tool calls but is actually prose (e.g., documentation examples) may be falsely parsed. The `generic` parser mitigates this by checking context.
- **Streaming**: Synax accumulates stream chunks and parses the complete response. Partial/incomplete tool calls are not emitted until the stream ends.
- **Some parsers are stubs**: `step3`, `step3p5`, `glm45`, `glm47` use fallback strategies pending more detailed format documentation from vLLM.

## References

- [vLLM Tool Calling Documentation](https://docs.vllm.ai/en/latest/features/tool_calling.html)
- vLLM `--tool-call-parser` flag: supported parsers in `vllm/entrypoints/openai/tool_parsers/`
- Synax parser source: `src/llm/parsers/`
