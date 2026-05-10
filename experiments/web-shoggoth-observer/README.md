# Shoggoth Observer — Synax Web Observer Experiment

**Read-only localhost web observer for watching the Synax agent's "core morphology."**

This is an isolated experimental branch (`experiment/web-shoggoth-observer`). It is a sandbox prototype, not production architecture.

## What This Is

A fullscreen black web page showing:

- An animated **Three.js "AI core morphology"** — a living containment field / sci-fi observation object in the center
- A **live transcript** of model thoughts/notes underneath
- **Subtle tool-call notifications** (toasts) in the upper right
- **Suspicious-tool-call observability** — visual indicators when the agent's tool calls look risky

The core morphology adapts the model-specific AI core visual profiles from the [Synax Core Morphology Viewer](https://github.com/achuthanmukundan00/synax/blob/main/specs/synax-ai-core-morphology-spec.md), ported from `~/workspace/git/achu-portfolio/src/components/three/SynaxAICore.tsx`.

## What This Is NOT

- ❌ Not a command/control surface
- ❌ Not a dashboard with forms or buttons (except "clear view")
- ❌ Not a production monitoring system
- ❌ Not exposed to the network — localhost only
- ❌ Does not expose filesystem access, shell execution, model endpoints, secrets, or API keys
- ❌ Does not block tool calls — the suspicious-tool heuristics only affect visual severity

## Safety Model

- **Read-only observer** — the browser UI watches, not steers
- **localhost-only** — the server binds to `127.0.0.1`
- **No browser input triggers tools**
- **No auth needed** — it's on localhost, behind your firewall
- **Telemetry bridge** silently fails if the observer server isn't running
- **Event buffer** bounded to 200 events in memory
- **No database** — all state is ephemeral

## How to Run

### 1. Start the observer server

```bash
npm run observer
# or
npm run dev:observer
```

This starts an HTTP server on `http://127.0.0.1:8559` that:
- Serves the web observer at `/`
- Provides an SSE endpoint at `/events`
- Accepts events from Synax at `POST /ingest`

### 2. Open the observer in a browser

```
http://127.0.0.1:8559
```

You should see the black screen with a calm, slowly breathing AI core.

### 3. Start a Synax chat session

In another terminal:
```bash
npm run synax -- chat
```

The chat session auto-connects to the observer via the bridge in `src/commands/chat.ts`.
If the observer server isn't running, events are silently dropped — Synax works normally.

### 4. Watch the shoggoth

Open `http://127.0.0.1:8559` in a browser.

The core reacts to model notes, tool calls, streaming text, and suspicious activity.

## Event Types

The observer understands these telemetry event types:

| Type              | Description                                    |
|-------------------|------------------------------------------------|
| `session_started` | Chat session began                             |
| `model_note`      | Model output (prose, notes, thoughts)          |
| `assistant_delta` | Streaming text delta from the assistant        |
| `tool_call_started` | A tool call is executing                    |
| `tool_call_finished` | Tool call completed successfully            |
| `tool_call_failed` | Tool call failed                              |
| `budget_update`   | Context budget usage update                    |
| `warning`         | Non-blocking warning                           |
| `error`           | Runtime error                                  |
| `session_finished` | Chat session ended                            |

## Phase-Driven Core Morphology

The 3D core responds to phases with subtle animation changes:

| Phase         | Core Behavior                                    |
|---------------|--------------------------------------------------|
| `idle`        | Slow breathing, calm teal containment field      |
| `thinking`    | Active particles, brighter nucleus pulsing       |
| `streaming`   | Pulsing green shimmer, ring oscillation          |
| `tool_running`| Amber scan lines, compressed field, faster spin  |
| `completed`   | Green calm pulse, settled field                  |
| `blocked`     | Amber/orange waiting state, sustained glow       |
| `error`       | Rapid pulse, red warning glow, distressed field  |

## Suspicious Tool-Call Heuristics

A small local heuristic layer classifies tool calls for **visual severity only**:

- **normal** — standard read, write, edit operations
- **attention** — touching .env, credentials, grep -r, cat ~/, etc.
- **suspicious** — paths outside workspace (/etc, /private, .ssh, ~/.aws), network commands (curl, wget, nc, ssh, scp), destructive commands (rm -rf, chmod, chown), git remote changes, package installs, secrets inspection

Severity only affects:
- Toast border and name color (amber for attention, red for suspicious)
- Core morphology gets a red-tinged severity pulse
- Suspicious toasts persist longer (15s vs 8s)

The heuristics are in `server/suspicious-tool-heuristics.ts` — simple string/path pattern matching.

## Three.js Core Morphology

Adapted from `~/workspace/git/achu-portfolio/src/components/three/SynaxAICore.tsx` and `SynaxCoreMorphology.tsx`.

The core consists of:
- **Outer containment rings** (3 torus rings at different angles)
- **Inner field ring segments** (28 box segments forming a dense ring)
- **Nucleus** (octahedron with emissive material, pulsing)
- **Nucleus halo** (transparent sphere glow)
- **Scan line** (horizontal beam sweeping up and down)
- **Vertical containment bars** (5 subtle vertical lines)
- **Particle field** (200 particles in additive blending)
- **Background specks** (30 fixed distant particles)

Color palette shifts based on phase and severity.

## Files

```
experiments/web-shoggoth-observer/
├── README.md                          # This file
├── run-observer.mjs                   # npm run observer entry point
├── server/
│   ├── observer-server.ts             # HTTP + SSE server (Node.js, no framework)
│   ├── telemetry-bridge.ts            # Synax → observer event relay
│   └── suspicious-tool-heuristics.ts  # Severity classification
└── public/
    ├── index.html                     # Web observer shell
    └── core-morphology.js             # Three.js core morphology + SSE client
```

## Known Limitations

- **No persistent state** — refresh the page and transcript resets
- **Single observer** — SSE broadcasts to all connected clients, but only one browser tab expected
- **No model profile auto-detection** — the core currently uses a default morphology. Model-specific profiles (Qwen lattice, DeepSeek furnace, etc.) from the portfolio are not yet wired to telemetry events
- **Bridge auto-wired via `require()` in `src/commands/chat.ts`** — silently no-ops if the experiment directory is removed
- **No test suite** — this is experimental. Smoke-test manually
- **Three.js loaded from CDN** — requires internet access for first load (cached thereafter)
- **TypeScript dependencies** — the server modules use TypeScript but run via `tsx` at runtime

## Follow-Up Work (Not in Scope)

- Auto-wire the bridge into `src/commands/chat.ts` behind a config flag
- Model-specific core profile from telemetry (pass modelId through events)
- Observer mode detect in CLI (`synax chat --observer`)
- Tool call detail (arguments, command display) in toasts
- Multiple observer tabs support with session isolation
- Persistent transcript export
- Sound design (ambient drone for core breathing)

## Attribution

The Three.js core morphology visual logic is adapted from the [Synax Core Morphology experiments](https://github.com/achuthanmukundan00/synax/blob/main/specs/synax-ai-core-morphology-spec.md) in `~/workspace/git/achu-portfolio/src/components/three/SynaxAICore.tsx`.

## Deleting This Experiment

```bash
git checkout main
git branch -D experiment/web-shoggoth-observer
rm -rf experiments/web-shoggoth-observer
```

No other files are affected.
