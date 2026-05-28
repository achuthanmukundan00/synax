# Consuming Synax

Synax is designed primarily as a CLI tool, but its core behavior relies on a clean, decoupled programmatic API that can be consumed directly by other applications.

By installing Synax, you can instantiate an agent session, integrate it with custom tool registries, or query holographic memory files directly from your own software.

## Installation

As of version 0.3.0-alpha, Synax is not yet published to a public npm registry. You have a few options for consuming it locally in other applications.

### 1. Bun Link

Use `bun link` to symbiotically manage your project and Synax while testing local changes.

In the Synax project root:

```bash
bun link
```

In your project root:

```bash
bun link synax
```

### 2. Local Folder Install

Install Synax exactly where it sits on the disk. This locks your project to the local Synax codebase, updating when its local Git repo updates.

```bash
bun add ../path/to/synax
```

### 3. Tarball Pack

Create a compressed tarball mimicking a remote registry release, and lock that version. Recommended option for pseudo-production testing.

In the Synax project root:

```bash
bun pm pack
```

This produces a file like `synax-0.1.0-alpha.1.tgz`.

In your project root:

```bash
bun add ../path/to/synax/synax-0.1.0-alpha.1.tgz
```

## Basic Consumption

Once installed via any of the above mechanisms, you can import and configure SDK features such as `Session`. Let's wire a simple chat turn over a mock client.

```ts
import { Session } from 'synax';

// Implement a minimal client adapter, typically bridging to Synax's real ProviderFactory
const client = {
  chat: async (req) => {
    return {
      message: {
        role: 'assistant',
        content: 'I am a Synax programming session initialized programmatically.',
        tool_calls: null,
      },
      logprobs: null,
      created: Date.now(),
      model: 'mistral-nemo',
    };
  },
};

async function check() {
  const session = new Session({ client, model: 'mistral-nemo' });

  // Pushing a new message simulates a turn in the active session configuration
  const result = await session.turn('Hello from another product!');
  console.log(result.message.content);
}

check();
```

## Optional Dependencies

Synax relies on `better-sqlite3` as an `.optionalDependencies` package. Products running on standard containerized and standard platforms will have no issues unpacking or compiling this dependency upon `bun install`.

However, some restricted environments, edge networks, browsers, or strictly statically analyzed bundlemaps may fail if a system build environment is unlinked.

Since it is marked as `optionalDependencies`, you can install Synax using standard tools like Bun while ignoring compilation failures or excluding the dependency without breaking base functionality. Holographic storage tools that explicitly rely on `sqlite` adapters may gracefully fail in those restricted environments without bringing down normal Chat behavior.
