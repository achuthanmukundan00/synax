#!/usr/bin/env node
/**
 * Benchmark runner for Synax agent workloads.
 *
 * Runs a workload file through the Synax agent runner non-interactively,
 * collects metrics, and emits JSON to stdout.
 *
 * Usage:
 *   node dist/scripts/bench-agent-workload.js fixtures/workloads/agent-mvp-long-prompt.txt
 *   node dist/scripts/bench-agent-workload.js --workload fixtures/workloads/agent-mvp-long-prompt.txt
 *
 * Environment:
 *   Uses the same config loading as `synax chat` (project .synax.toml, global config).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { performance } from 'perf_hooks';

import { loadProjectConfig, normalizeProviderConfig } from '../config/project';
import { createOpenAICompatibleClient } from '../llm/client';
import { runAgentTurn, type AgentClient, type AgentTurnResult, type AgentActivity } from '../agent/runner';
import { type ChatResponse, type ChatOptions } from '../llm/types';
import {
  computeReadMetrics,
  computeObjectiveScore,
  computeTokenGrowth,
  isRecoverableError,
} from '../benchmark/metrics';
import {
  type BenchmarkResult,
  type BenchmarkMetrics,
  type ToolCallEntry,
} from '../benchmark/types';
import { runVerification } from '../agent/verification';

// ---------------------------------------------------------------------------
// CLI argument parsing (minimal, no commander dependency for scripts)
// ---------------------------------------------------------------------------

function parseArgs(): { workload: string; outputFile?: string; runVerification: boolean } {
  const args = process.argv.slice(2);
  let workload = '';
  let outputFile: string | undefined;
  let runVerificationFlag = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--workload' || args[i] === '-w') {
      workload = args[++i] ?? '';
    } else if (args[i] === '--output' || args[i] === '-o') {
      outputFile = args[++i] ?? '';
    } else if (args[i] === '--verify') {
      runVerificationFlag = true;
    } else if (!workload) {
      workload = args[i];
    }
  }

  if (!workload) {
    console.error('Usage: bench-agent-workload --workload <path> [--output <path>] [--verify]');
    process.exit(1);
  }

  return { workload, outputFile, runVerification: runVerificationFlag };
}

// ---------------------------------------------------------------------------
// Timed client wrapper
// ---------------------------------------------------------------------------

interface TimedClient extends AgentClient {
  /** Get accumulated model wall time in milliseconds. */
  getModelWallMs(): number;
}

function wrapClientWithTiming(client: AgentClient): TimedClient {
  let modelWallMs = 0;

  return {
    getModelWallMs(): number {
      return modelWallMs;
    },
    async chat(options: ChatOptions): Promise<ChatResponse> {
      const start = performance.now();
      try {
        const result = await client.chat(options);
        modelWallMs += performance.now() - start;
        return result;
      } catch (error) {
        modelWallMs += performance.now() - start;
        throw error;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tool call extraction from conversation
// ---------------------------------------------------------------------------

/**
 * Extract tool call entries from agent turn result.
 *
 * Uses result.toolCalls (the runner's ground truth for success/error)
 * supplemented with argument data extracted from conversation messages
 * in both OpenAI JSON and content_xml formats.
 */
function extractToolCallEntries(
  result: AgentTurnResult,
): ToolCallEntry[] {
  const messages = result.conversation.messages;

  // Extract argument lists from assistant messages (OpenAI + XML)
  const callArgLists: Array<Record<string, unknown>> = [];

  for (const msg of messages) {
    const msgRecord = msg as unknown as Record<string, unknown>;

    // OpenAI format: tool_calls array with function.arguments
    if (msg.role === 'assistant' && Array.isArray(msgRecord.tool_calls)) {
      const toolCalls = msgRecord.tool_calls as Array<{
        function?: { name: string; arguments: string };
        name?: string;
      }>;
      for (const tc of toolCalls) {
        if (tc.function?.arguments) {
          try {
            callArgLists.push(JSON.parse(tc.function.arguments) as Record<string, unknown>);
          } catch {
            callArgLists.push({});
          }
        } else {
          callArgLists.push({});
        }
      }
    }

    // XML format: <tool_call> tags in content
    if (msg.role === 'assistant' && typeof msg.content === 'string') {
      const xmlCalls = parseXmlToolCallArgs(msg.content);
      callArgLists.push(...xmlCalls);
    }
  }

  // Match result.toolCalls (ground truth) with extracted arguments by position
  return result.toolCalls.map((rtc, i) => ({
    name: rtc.name,
    success: rtc.success,
    error: rtc.error,
    arguments: callArgLists[i] ?? {},
  }));
}

/**
 * Parse tool call arguments from XML-format assistant content.
 * Looks for <tool_call>{"name":"...","arguments":{...}}</tool_call> blocks.
 */
function parseXmlToolCallArgs(content: string): Array<Record<string, unknown>> {
  const results: Array<Record<string, unknown>> = [];
  const regex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim()) as Record<string, unknown>;
      if (typeof parsed.arguments === 'object' && parsed.arguments !== null) {
        results.push(parsed.arguments as Record<string, unknown>);
      } else {
        results.push({});
      }
    } catch {
      results.push({});
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Main benchmark function
// ---------------------------------------------------------------------------

async function runBenchmark(workloadPath: string, runVerificationFlag: boolean): Promise<BenchmarkResult> {
  const repoRoot = process.cwd();

  // Load the workload file
  let task: string;
  try {
    task = readFileSync(workloadPath, 'utf-8').trim();
  } catch {
    console.error(`Cannot read workload file: ${workloadPath}`);
    process.exit(1);
  }

  if (!task) {
    console.error('Workload file is empty.');
    process.exit(1);
  }

  // Load config
  const loaded = loadProjectConfig(repoRoot);
  if (loaded.errors.length > 0) {
    console.error(
      `Config errors:\n${loaded.errors.map((e) => `${e.path}: ${e.message}`).join('\n')}`,
    );
  }

  const providerConfig = normalizeProviderConfig(loaded.config.provider ?? {});
  if (!providerConfig.model.trim()) {
    console.error('Provider model is not configured. Set provider.model in .synax.toml.');
    process.exit(1);
  }

  // Create timed client
  const rawClient = createOpenAICompatibleClient(providerConfig);
  const timedClient = wrapClientWithTiming(rawClient);

  // Collectors for intermediate metrics
  const stepPromptTokens: number[] = [];

  // Run the agent
  const overallStart = performance.now();

  const result = await runAgentTurn({
    repoRoot,
    task,
    client: timedClient,
    maxSteps: loaded.config.maxModelSteps,
    maxToolCalls: loaded.config.maxToolCalls,
    tools: { bashEnabled: loaded.config.tools?.bash?.enabled },
    contextBudget: {
      contextBudgetTokens: loaded.config.contextBudgetTokens,
      contextWindowTokens: loaded.config.contextWindowTokens,
      reservedOutputTokens: loaded.config.reservedOutputTokens,
      keepRecentTokens: loaded.config.keepRecentTokens,
      maxSingleReadResultTokens: loaded.config.maxSingleReadResultTokens,
      maxTotalReadResultTokensPerTurn: loaded.config.maxTotalReadResultTokensPerTurn,
    },
    onActivity(_activity: AgentActivity) {
      // Activity tracking for CLI output would go here.
      // The benchmark captures timing via the timed client wrapper.
    },
    onBudget(snapshot) {
      stepPromptTokens.push(snapshot.estimatedInputTokens);
    },
  });

  const totalWallMs = performance.now() - overallStart;

  // Timing decomposition: model time is captured by the wrapper,
  // the rest is tool execution + overhead.
  const modelWallMs = timedClient.getModelWallMs();
  const estimatedToolWallMs = Math.max(0, totalWallMs - modelWallMs);

  // Extract tool call entries from conversation
  const toolCallEntries = extractToolCallEntries(result);

  // Compute read metrics
  const readMetrics = computeReadMetrics(toolCallEntries);

  // Count recoverable vs terminal errors
  let recoverableToolErrors = 0;
  let terminalErrorsCount = 0;

  for (const tc of toolCallEntries) {
    if (!tc.success) {
      if (isRecoverableError(tc)) {
        recoverableToolErrors += 1;
      } else {
        terminalErrorsCount += 1;
      }
    }
  }

  // If the run terminated with tool_error but no tool-level errors (recoverable
  // or terminal) were counted, the failure was caused by a policy limit in the
  // runner itself (e.g. consecutive recoverable error hard-stop). Count it.
  if (result.terminalState === 'tool_error' && terminalErrorsCount === 0 && recoverableToolErrors === 0) {
    terminalErrorsCount = 1;
  }

  // Compute token metrics
  const maxPromptTokens = stepPromptTokens.length > 0 ? Math.max(...stepPromptTokens) : 0;
  const promptTokenGrowth = computeTokenGrowth(stepPromptTokens);

  // Run verification if requested
  let testsPassed: boolean | null = null;
  if (runVerificationFlag) {
    const verification = await runVerification({
      repoRoot,
      command: loaded.config.verification?.defaultCommand,
      timeoutMs: 120000,
    });
    testsPassed = verification.state === 'passed'
      ? true
      : verification.state === 'failed'
        ? false
        : null;
  }

  // Build metrics
  const metrics: BenchmarkMetrics = {
    terminalStatus: result.terminalState,
    completed: result.terminalState === 'completed',
    totalWallMs: Math.round(totalWallMs),
    modelWallMs: Math.round(modelWallMs),
    toolWallMs: Math.round(estimatedToolWallMs),
    modelSteps: result.steps,
    stepPromptTokens,
    maxPromptTokens,
    promptTokenGrowth,
    toolCalls: toolCallEntries.length,
    readCalls: readMetrics.readCalls,
    uniqueReadPaths: readMetrics.uniqueReadPaths,
    repeatedReadCalls: readMetrics.repeatedReadCalls,
    directoryReadCalls: readMetrics.directoryReadCalls,
    recoverableToolErrors,
    terminalErrors: terminalErrorsCount,
    changedFiles: result.changedFiles.length,
    testsPassed,
    score: 0, // computed below
    error: result.error,
  };

  metrics.score = computeObjectiveScore(metrics);

  return {
    workload: workloadPath,
    timestamp: new Date().toISOString(),
    metrics,
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { workload, outputFile, runVerification: runVerificationFlag } = parseArgs();

  console.error(`[bench] Running workload: ${workload}`);
  console.error(`[bench] Repo root: ${process.cwd()}`);

  const result = await runBenchmark(workload, runVerificationFlag);

  const json = JSON.stringify(result, null, 2);

  if (outputFile) {
    const dir = join(outputFile, '..');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(outputFile, json, 'utf-8');
    console.error(`[bench] Results written to: ${outputFile}`);
  }

  // Always write to stdout for piping
  console.log(json);
}

main().catch((error) => {
  console.error(`[bench] Fatal error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
