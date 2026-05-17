/**
 * @preview-fixture — run with: npx tsx scripts/preview-morphology.ts
 * Preview fixture for the Synax Morphology TUI aesthetic.
 *
 * Usage:
 *   npx ts-node scripts/preview-morphology.ts [swarm|memory-conflict|handoff|agent|all]
 *
 * Demonstrates the new presentation layer rendering with:
 * - bold labels, colorful glyphs, colored horizontal rules
 * - no vertical box-drawing characters
 * - subagent/handoff/memory-aware previews
 * - artifact-first results
 * - calm but lively production dev tool feel
 */
import {
  createInitialPresentationState,
  createMorphologyTheme,
  renderAnsi,
  renderPlainText,
} from '../src/presentation';
import type { PresentationState, PresentationBlock } from '../src/presentation/types';

function asciiRender(state: PresentationState): string {
  return renderPlainText(state, { showToolActivity: true, showRuntimeStatus: true });
}

function ansiRender(state: PresentationState): string {
  const theme = createMorphologyTheme();
  return renderAnsi(state, theme, {
    terminalWidth: 80,
    showHeader: true,
    showMemory: true,
    showHandoff: true,
    showAgentPanes: true,
  });
}

// ── Swarm: 9 agent panes ──────────────────────────────────────────
function swarmFixture(): PresentationState {
  const agents = [
    {
      id: 'a1',
      role: 'file-scout',
      model: 'qwen-7b',
      phase: 'completed',
      lastAction: 'scanned 23 files',
      finding: '3 candidates found',
      changedFiles: ['src/utils.ts', 'src/types.ts'],
    },
    {
      id: 'a2',
      role: 'bug-hunter',
      model: 'qwen-7b',
      phase: 'active',
      lastAction: 'running tests',
      finding: '2/4 tests failing',
    },
    {
      id: 'a3',
      role: 'refactor-guard',
      model: 'qwen-7b',
      phase: 'completed',
      lastAction: 'verified 5 contracts',
      finding: 'all contracts pass',
      changedFiles: [],
    },
    { id: 'a4', role: 'doc-scribe', model: 'qwen-3b', phase: 'pending', lastAction: 'queued' },
    {
      id: 'a5',
      role: 'lint-sweeper',
      model: 'qwen-3b',
      phase: 'failed',
      lastAction: 'failed: timeout',
      finding: 'connection lost',
    },
    { id: 'a6', role: 'test-writer', model: 'qwen-7b', phase: 'active', lastAction: 'writing cases' },
    {
      id: 'a7',
      role: 'dep-checker',
      model: 'qwen-3b',
      phase: 'completed',
      lastAction: 'no issues',
      finding: '0 outdated deps',
      changedFiles: [],
    },
    {
      id: 'a8',
      role: 'style-linter',
      model: 'qwen-3b',
      phase: 'completed',
      lastAction: 'prettier check passed',
      finding: 'formatting ok',
      changedFiles: [],
    },
    { id: 'a9', role: 'sec-auditor', model: 'qwen-7b', phase: 'active', lastAction: 'auditing deps' },
  ] as PresentationState['agentPanes'];

  const blocks: PresentationBlock[] = [
    { kind: 'runtime_status', label: 'model', value: 'qwen2.5-coder-32b @ localhost:11434', priority: 'line' },
    { kind: 'runtime_status', label: 'mode', value: 'swarm (9 agents)', priority: 'line' },
    {
      kind: 'orchestration',
      mode: 'parallel',
      phase: 'active',
      summary: '9 sub-tasks planned, mode: orchestrate',
      subAgents: [
        { id: 'a1', task: 'Scan filesystem for relevant modules', phase: 'completed', changedFiles: ['src/utils.ts'] },
        { id: 'a2', task: 'Hunt bugs in auth module', phase: 'active' },
        { id: 'a3', task: 'Verify refactoring contracts', phase: 'completed' },
        { id: 'a4', task: 'Generate API docs', phase: 'pending' },
        { id: 'a5', task: 'Lint sweep src/', phase: 'failed', error: 'timeout' },
        { id: 'a6', task: 'Write unit tests', phase: 'active' },
        { id: 'a7', task: 'Check dependency freshness', phase: 'completed' },
        { id: 'a8', task: 'Run prettier check', phase: 'completed' },
        { id: 'a9', task: 'Security audit dependencies', phase: 'active' },
      ],
    },
    {
      kind: 'model_output',
      role: 'primary',
      text: 'Swarm orchestration complete. 4/9 agents finished, 3 active, 1 failed, 1 pending. Failed agent (a5: lint-sweeper) hit timeout — retrying with increased budget.',
    },
  ];

  const state = { ...createInitialPresentationState(), blocks, agentPanes: agents };
  return state;
}

// ── Memory Conflict ───────────────────────────────────────────────
function memoryConflictFixture(): PresentationState {
  const memoryDecisions = [
    {
      label: 'project:synax/tui-symbols',
      disposition: 'used' as const,
      reason: 'matched current workspace',
      provenance: 'session-abc / 3h ago',
    },
    {
      label: 'project:synax/cli-is-subset',
      disposition: 'used' as const,
      reason: 'constraint validated',
      provenance: 'session-abc / 3h ago',
    },
    {
      label: 'cwd',
      disposition: 'rejected' as const,
      reason: 'stale — live pwd differs',
      provenance: 'session-xyz / 2d ago',
      conflict: true,
      stale: true,
    },
    {
      label: 'branch',
      disposition: 'rejected' as const,
      reason: 'stale — live branch differs',
      provenance: 'session-xyz / 2d ago',
      conflict: true,
      stale: true,
    },
    {
      label: 'open ports',
      disposition: 'quarantined' as const,
      reason: 'untrusted memory source',
      provenance: 'unknown / 5d ago',
    },
  ];

  const blocks: PresentationBlock[] = [
    { kind: 'runtime_status', label: 'model', value: 'frontier-sonnet-4 @ api.anthropic.com', priority: 'line' },
    { kind: 'runtime_status', label: 'mode', value: 'patch', priority: 'line' },
    { kind: 'runtime_status', label: 'context', value: '4500 / 32000 (14%)', priority: 'detail' },
    {
      kind: 'tool_activity',
      toolName: 'memory_retrieve',
      phase: 'completed',
      summary: '5 memories retrieved · 3 rejected/stale',
    },
    {
      kind: 'model_output',
      role: 'primary',
      text: 'Loaded 2 relevant memories. Detected stale cwd/branch state from old session — overriding with live pwd. 1 memory quarantined from untrusted source.',
    },
    { kind: 'runtime_status', label: 'tokens', value: 'in: 4500, out: 340, cost: $0.0150', priority: 'detail' },
  ];

  return {
    ...createInitialPresentationState(),
    blocks,
    memoryDecisions,
    liveRepoState: { cwd: '/Users/dev/workspace/git/synax', branch: 'feat/tui-morphology', repo: 'synax' },
  };
}

// ── Handoff ───────────────────────────────────────────────────────
function handoffFixture(): PresentationState {
  const handoffPackets = [
    {
      source: 'qwen2.5-coder-32b',
      target: 'deepseek-coder-6.7b',
      reason: 'budget exhausted — handoff to cheaper model for cleanup',
      summary: 'Core refactoring complete (12 files). Remaining: format, lint, verify.',
      includedContext: ['changed files', 'test results', 'refactoring notes'],
      excludedContext: ['raw tool outputs', 'scratchpad'],
    },
    {
      source: 'deepseek-coder-6.7b',
      target: 'qwen2.5-coder-32b',
      reason: 'verification failure — returning to primary model',
      summary: 'Lint check passed. 2 integration tests failing — needs investigation.',
      includedContext: ['lint output', 'failing test details', 'git diff summary'],
      excludedContext: [],
    },
  ];

  const blocks: PresentationBlock[] = [
    { kind: 'runtime_status', label: 'model', value: 'qwen2.5-coder-32b @ localhost:11434', priority: 'line' },
    { kind: 'runtime_status', label: 'mode', value: 'patch (with handoff)', priority: 'line' },
    {
      kind: 'model_output',
      role: 'primary',
      text: 'Handoff chain active. Primary model exhausted budget on refactoring — cheaper model handling cleanup. Will return if verification fails.',
    },
    { kind: 'tool_activity', toolName: 'read', phase: 'completed', summary: 'lint output reviewed' },
    {
      kind: 'runtime_status',
      label: 'summary',
      value: 'Status: user_input_required · 4 steps · 1 tool calls · 12 files',
      priority: 'line',
    },
  ];

  return { ...createInitialPresentationState(), blocks, handoffPackets };
}

// ── Agent with role ───────────────────────────────────────────────
function agentFixture(role: string): PresentationState {
  const agentPanes = [
    {
      id: 'agent-1',
      role,
      model: 'qwen-7b',
      phase: (role === 'memory-scout' ? 'active' : 'completed') as 'active' | 'completed',
      lastAction: role === 'memory-scout' ? 'retrieving memories' : 'done',
      finding: role === 'memory-scout' ? '2 memories found, 1 stale cwd rejected' : 'all checks passed',
      changedFiles: role === 'memory-scout' ? undefined : ['src/index.ts'],
    },
  ];

  const blocks: PresentationBlock[] = [
    { kind: 'runtime_status', label: 'model', value: 'qwen-7b @ local', priority: 'line' },
    { kind: 'runtime_status', label: 'mode', value: `agent (${role})`, priority: 'line' },
    {
      kind: 'model_output',
      role: 'primary',
      text: `Agent role: ${role}. ${role === 'memory-scout' ? 'Scanning session memory for relevant context...' : 'Task complete.'}`,
    },
  ];

  return {
    ...createInitialPresentationState(),
    blocks,
    agentPanes,
    ...(role === 'memory-scout'
      ? {
          memoryDecisions: [
            { label: 'project:synax/config', disposition: 'used' as const, reason: 'relevant', provenance: 'today' },
            {
              label: 'cwd',
              disposition: 'rejected' as const,
              reason: 'stale',
              provenance: 'yesterday',
              stale: true,
              conflict: true,
            },
          ],
          liveRepoState: { cwd: '/Users/dev/workspace/git/synax', branch: 'main' },
        }
      : {}),
  };
}

// ── Main ──────────────────────────────────────────────────────────
function main() {
  const arg = process.argv[2] ?? 'all';

  const fixtures: Record<string, () => { state: PresentationState; label: string }> = {
    swarm: () => ({ state: swarmFixture(), label: 'Swarm (9 agent panes)' }),
    'memory-conflict': () => ({ state: memoryConflictFixture(), label: 'Memory Conflict (stale cwd rejection)' }),
    handoff: () => ({ state: handoffFixture(), label: 'Handoff Chain' }),
    'agent-memory': () => ({ state: agentFixture('memory-scout'), label: 'Agent (memory-scout)' }),
    agent: () => ({ state: agentFixture('code-reviewer'), label: 'Agent (code-reviewer)' }),
    all: () => {
      // Render all fixtures sequentially
      const allFixtures = [
        { state: swarmFixture(), label: 'Swarm (9 agent panes)' },
        { state: memoryConflictFixture(), label: 'Memory Conflict (stale cwd rejection)' },
        { state: handoffFixture(), label: 'Handoff Chain' },
        { state: agentFixture('memory-scout'), label: 'Agent (memory-scout)' },
      ];
      for (const f of allFixtures) {
        renderFixture(f.state, f.label);
      }
      return { state: createInitialPresentationState(), label: 'all' };
    },
  };

  const entry = fixtures[arg];
  if (!entry) {
    console.error(`Unknown fixture: ${arg}`);
    console.error(`Available: ${Object.keys(fixtures).join(', ')}`);
    process.exit(1);
  }

  const { state, label } = entry();
  if (arg !== 'all') {
    renderFixture(state, label);
  }
}

function renderFixture(state: PresentationState, label: string) {
  // Render ANSI version (may contain escape codes)
  const ansi = ansiRender(state);

  // Render plain text version
  const plain = asciiRender(state);

  console.log('');
  console.log('═'.repeat(80));
  console.log(`  ${label}`);
  console.log('═'.repeat(80));
  console.log('');
  console.log('─── ANSI (Morphology) ───');
  console.log(ansi);
  console.log('─── Plain Text ───');
  console.log(plain);
  console.log('─'.repeat(80));
}

main();
