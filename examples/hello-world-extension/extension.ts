/**
 * Hello World Extension — EventBus subscriber example.
 *
 * Demonstrates:
 *   1. Subscribing to lifecycle events on the EventBus
 *   2. Subscribing to control hooks to observe tool calls
 *   3. Logging tool execution details
 *
 * Usage:
 *   This extension is automatically loaded when the skill directory
 *   is provided via --skill. The EventBus is available on the Session
 *   object created by `synax chat` or `synax run`.
 *
 *   ```sh
 *   synax chat --skill examples/hello-world-extension
 *   ```
 *
 *   Or programmatically:
 *   ```ts
 *   import { Session } from 'synax';
 *   import { helloWorldExtension } from './extension';
 *
 *   const session = new Session({ ... });
 *   helloWorldExtension(session.eventBus);
 *   await session.start();
 *   ```
 */

import type { EventBus } from '../../src/events/EventBus';

/**
 * Attach the hello-world extension to a Session's EventBus.
 *
 * Subscribes to lifecycle events and logs a friendly summary
 * of each tool call and turn completion.
 */
export function helloWorldExtension(bus: EventBus): () => void {
  const unsubscribers: Array<() => void> = [];

  // ── Log every tool call start ──────────────────────────────────────
  unsubscribers.push(
    bus.on('tool_execution_start', (event) => {
      console.log(`🔧 Tool: ${event.toolName} (call ${event.toolCallId})`);
      const args = event.arguments;
      if (args) {
        const argSummary = Object.entries(args)
          .map(([k, v]) => `${k}=${String(v).slice(0, 60)}`)
          .join(', ');
        console.log(`   Args: ${argSummary}`);
      }
    }),
  );

  // ── Log every tool call result ─────────────────────────────────────
  unsubscribers.push(
    bus.on('tool_execution_end', (event) => {
      const status = event.success ? '✅' : '❌';
      console.log(`${status} ${event.toolName}: ${event.success ? 'ok' : event.error}`);
    }),
  );

  // ── Log turn starts ────────────────────────────────────────────────
  unsubscribers.push(
    bus.on('turn_start', (event) => {
      console.log(`\n── Turn ${event.stepIndex} ──`);
    }),
  );

  // ── Log turn completions ───────────────────────────────────────────
  unsubscribers.push(
    bus.on('turn_end', (event) => {
      console.log(
        `── Turn ${event.stepIndex} end: ${event.terminalState}, ${event.toolCalls} tool call(s), ${event.steps} step(s)`,
      );
    }),
  );

  // ── Observational control hook (never blocks) ──────────────────────
  unsubscribers.push(
    bus.onControl('pre_tool_use', (event) => {
      console.log(`   [hook] pre_tool_use: ${event.toolName}`);
      return { allow: true };
    }),
  );

  // ── Return cleanup function ────────────────────────────────────────
  return () => {
    for (const unsub of unsubscribers) {
      unsub();
    }
  };
}

/**
 * Standalone: if run directly, print the extension description.
 */
if (require.main === module) {
  console.log('Hello World Extension for Synax');
  console.log('================================');
  console.log('');
  console.log('This extension demonstrates:');
  console.log('  1. EventBus lifecycle subscriptions');
  console.log('  2. Control hook registration');
  console.log('  3. Tool call logging');
  console.log('');
  console.log('Usage: synax chat --skill examples/hello-world-extension');
}
