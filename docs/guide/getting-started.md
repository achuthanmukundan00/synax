# Getting Started

## Requirements

- Node.js 18 or newer
- npm
- Git
- Relay or another OpenAI-compatible local server

## Install From Source

```sh
git clone git@github.com:achuthanmukundan00/synax.git
cd synax
npm install
npm run build
```

During local development, run the built CLI through the package script:

```sh
npm run synax -- --help
```

After publishing or linking the package, the command name is:

```sh
synax
```

## Create Project Config

Synax works with defaults, but a `.synax.toml` makes provider and verification behavior explicit:

```sh
cp .synax.toml.example .synax.toml
```

Pick a provider. Local Relay is the default:

```toml
[provider]
provider = "relay"
base_url = "http://127.0.0.1:1234/v1"
model = "Qwen3.6-35B-A3B-UD-IQ3_XXS.gguf"
context_window = 131072
```

Cloud providers need an API key:

```toml
[provider]
provider = "deepseek"
model = "deepseek-chat"
api_key_env = "DEEPSEEK_API_KEY"
```

Built-in presets: `relay`, `deepseek`, `anthropic`, `openrouter`, `groq`, `mistral`, `together`, and `custom` for any OpenAI-compatible endpoint.

For local models, set `tool_call_parser` to match your model family so Synax can extract tool calls from raw output:

```toml
[provider]
provider = "relay"
model = "Qwen3.6-35B-A3B"
tool_call_parser = "qwen3_xml"
```

Synax auto-detects the parser from your model name if you don't set it explicitly. See the [Tool-Call Parsing guide](/guide/tool-call-parsing) for the full parser matrix.

## Check The Setup

Run a quick local health check:

```sh
npm run synax -- doctor
```

Run the full provider check after Relay is running:

```sh
npm run synax -- doctor --full
```

Full doctor mode probes `/models` and sends a small `/chat/completions` request. Quick mode skips live provider calls.

## First Session

```sh
npm run synax -- inspect
npm run synax -- ask --question "Summarize this repository in five bullets."
npm run synax -- chat
```

Inside chat:

```txt
synax> /settings
synax> /tools
synax> /budget
synax> /test-provider
synax> Explain how config loading works.
synax> /verify
synax> /exit
```

For one bounded edit-capable task:

```sh
npm run synax -- run --task "Fix the failing test"
```

`synax run --plan plan.md` is accepted by the CLI, but the plan execution engine is still a placeholder.
