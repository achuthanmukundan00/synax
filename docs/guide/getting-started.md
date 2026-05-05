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

Edit the model name to match the model exposed by Relay.

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
