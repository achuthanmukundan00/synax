/**
 * Tests for dispatch-intent module.
 *
 * Covers:
 * - classifyDispatchIntent fast-path routing
 * - detectExplicitDelegationIntent patterns
 * - detectRepoReconIntent patterns
 * - buildRepoReconTasks domain decomposition
 * - normalizeDispatchPlan guard invariants
 */

import {
  classifyDispatchIntent,
  detectExplicitDelegationIntent,
  detectRepoReconIntent,
  buildRepoReconTasks,
  normalizeDispatchPlan,
  type RepoHints,
} from '../agent/dispatch-intent';

// ─── classifyDispatchIntent ──────────────────────────────────────────────────

describe('classifyDispatchIntent', () => {
  it('returns explicit_delegation for "use subagents"', () => {
    const result = classifyDispatchIntent('use subagents to refactor the auth module');
    expect(result.kind).toBe('explicit_delegation');
    if (result.kind === 'explicit_delegation') {
      expect(result.mode).toBe('auto');
      expect(result.cleanTask).not.toContain('subagents');
    }
  });

  it('returns explicit_delegation for "parallel sub-agents"', () => {
    const result = classifyDispatchIntent('use parallel sub-agents to audit all files');
    expect(result.kind).toBe('explicit_delegation');
    if (result.kind === 'explicit_delegation') {
      expect(result.mode).toBe('parallel');
    }
  });

  it('returns explicit_delegation for "sequential sub-agents"', () => {
    const result = classifyDispatchIntent('run sequential sub-agents for the pipeline');
    expect(result.kind).toBe('explicit_delegation');
    if (result.kind === 'explicit_delegation') {
      expect(result.mode).toBe('sequential');
    }
  });

  it('returns explicit_delegation for "delegate" phrasing', () => {
    const result = classifyDispatchIntent('delegate the file reads to separate agents');
    expect(result.kind).toBe('explicit_delegation');
  });

  it('returns explicit_delegation for "fan out" phrasing', () => {
    const result = classifyDispatchIntent('fan out the research across multiple agents');
    expect(result.kind).toBe('explicit_delegation');
  });

  it('returns explicit_delegation for "spawn agents" phrasing', () => {
    const result = classifyDispatchIntent('spawn agents to analyze each module');
    expect(result.kind).toBe('explicit_delegation');
  });

  it('returns explicit_delegation for "dispatch agents" phrasing', () => {
    const result = classifyDispatchIntent('dispatch agents to check all the things');
    expect(result.kind).toBe('explicit_delegation');
  });

  it('returns explicit_delegation for "use agents"', () => {
    const result = classifyDispatchIntent('use agents to handle the migrations');
    expect(result.kind).toBe('explicit_delegation');
  });

  it('returns explicit_delegation for "parallel agents"', () => {
    const result = classifyDispatchIntent('run parallel agents for the file audit');
    expect(result.kind).toBe('explicit_delegation');
    if (result.kind === 'explicit_delegation') {
      expect(result.mode).toBe('parallel');
    }
  });

  it('returns repo_reconnaissance for "read all the code"', () => {
    const result = classifyDispatchIntent('read all the code and tell me what it does');
    expect(result.kind).toBe('repo_reconnaissance');
  });

  it('returns repo_reconnaissance for "understand this repository"', () => {
    const result = classifyDispatchIntent('I want to understand this repository');
    expect(result.kind).toBe('repo_reconnaissance');
  });

  it('returns repo_reconnaissance for "audit the entire codebase"', () => {
    const result = classifyDispatchIntent('audit the entire codebase for security issues');
    expect(result.kind).toBe('repo_reconnaissance');
  });

  it('returns repo_reconnaissance for "overview of this repo"', () => {
    const result = classifyDispatchIntent('give me an overview of this repo');
    expect(result.kind).toBe('repo_reconnaissance');
  });

  it('returns requires_llm_planning for ordinary prompts', () => {
    const result = classifyDispatchIntent('fix the bug in the login form');
    expect(result.kind).toBe('requires_llm_planning');
  });

  it('returns requires_llm_planning for empty prompts', () => {
    const result = classifyDispatchIntent('');
    expect(result.kind).toBe('requires_llm_planning');
  });
});

// ─── detectExplicitDelegationIntent ──────────────────────────────────────────

describe('detectExplicitDelegationIntent', () => {
  it('returns null for prompts without delegation keywords', () => {
    expect(detectExplicitDelegationIntent('fix the bug')).toBeNull();
  });

  it('returns null for unrelated text', () => {
    expect(detectExplicitDelegationIntent('what is the meaning of life?')).toBeNull();
  });

  it('strips the trigger phrase from cleanTask', () => {
    const result = detectExplicitDelegationIntent('use subagents to refactor auth');
    expect(result).not.toBeNull();
    if (result) {
      expect(result.cleanTask).toBe('to refactor auth');
    }
  });

  it('handles hyphenated sub-agents', () => {
    const result = detectExplicitDelegationIntent('use sub-agents to test the API');
    expect(result).not.toBeNull();
    if (result) {
      expect(result.mode).toBe('auto');
    }
  });
});

// ─── detectRepoReconIntent ───────────────────────────────────────────────────

describe('detectRepoReconIntent', () => {
  it('detects "read all the code"', () => {
    expect(detectRepoReconIntent('read all the code')).toBe(true);
  });

  it('detects "read the entire repo"', () => {
    expect(detectRepoReconIntent('I want to read the entire repo')).toBe(true);
  });

  it('detects "scan the codebase"', () => {
    expect(detectRepoReconIntent('scan the codebase for vulnerabilities')).toBe(true);
  });

  it('detects "inspect the repository"', () => {
    expect(detectRepoReconIntent('inspect the repository structure')).toBe(true);
  });

  it('detects "survey the project"', () => {
    expect(detectRepoReconIntent('survey the project architecture')).toBe(true);
  });

  it('detects "audit the code"', () => {
    expect(detectRepoReconIntent('audit the code for best practices')).toBe(true);
  });

  it('detects "explore the repo"', () => {
    expect(detectRepoReconIntent('explore the repo and summarize')).toBe(true);
  });

  it('detects "architecture of this project"', () => {
    expect(detectRepoReconIntent('what is the architecture of this project?')).toBe(true);
  });

  it('detects "questions about it" after read intent', () => {
    expect(detectRepoReconIntent('read all the files, i want to ask you questions about it')).toBe(true);
  });

  it('detects "questions about the code"', () => {
    expect(detectRepoReconIntent('I want to ask you questions about the code')).toBe(true);
  });

  it('detects repo-recon jargon', () => {
    expect(detectRepoReconIntent('run repo-recon on this project')).toBe(true);
  });

  it('returns false for normal task prompts', () => {
    expect(detectRepoReconIntent('add error handling to the login function')).toBe(false);
  });

  it('returns false for empty prompts', () => {
    expect(detectRepoReconIntent('')).toBe(false);
  });

  it('returns false for single-word prompts', () => {
    expect(detectRepoReconIntent('hello')).toBe(false);
  });
});

// ─── buildRepoReconTasks ─────────────────────────────────────────────────────

describe('buildRepoReconTasks', () => {
  const smallHints: RepoHints = {
    fileCount: 20,
    hasTui: true,
    hasTests: true,
    hasDocs: true,
    domains: ['typescript'],
  };

  const mediumHints: RepoHints = {
    fileCount: 100,
    hasTui: true,
    hasTests: true,
    hasDocs: true,
    domains: ['typescript', 'node'],
  };

  const largeHints: RepoHints = {
    fileCount: 600,
    hasTui: true,
    hasTests: true,
    hasDocs: true,
    domains: ['typescript', 'node', 'react'],
  };

  const noTuiHints: RepoHints = {
    fileCount: 100,
    hasTui: false,
    hasTests: true,
    hasDocs: true,
    domains: ['python'],
  };

  it('returns exactly 3 tasks for tiny repos (< 30 files)', () => {
    const tasks = buildRepoReconTasks(smallHints);
    expect(tasks).toHaveLength(3);
    const ids = tasks.map((t) => t.id);
    expect(ids).toEqual(['repo-map', 'runtime-flow', 'tests-quality']);
  });

  it('returns 6 tasks for medium repos with all domains', () => {
    const tasks = buildRepoReconTasks(mediumHints);
    expect(tasks.length).toBe(6);
  });

  it('returns up to 7 tasks for large repos', () => {
    const largeHints: RepoHints = {
      fileCount: 600,
      hasTui: true,
      hasTests: true,
      hasDocs: true,
      domains: ['typescript', 'node', 'react'],
    };
    const tasks = buildRepoReconTasks(largeHints);
    expect(tasks.length).toBeGreaterThanOrEqual(5);
    expect(tasks.length).toBeLessThanOrEqual(7);
  });

  it('includes tui-rendering only when hasTui is true', () => {
    const withTui = buildRepoReconTasks(mediumHints);
    expect(withTui.find((t) => t.id === 'tui-rendering')).toBeDefined();

    const withoutTui = buildRepoReconTasks(noTuiHints);
    expect(withoutTui.find((t) => t.id === 'tui-rendering')).toBeUndefined();
  });

  it('includes agent-system for non-tiny repos', () => {
    const tasks = buildRepoReconTasks(mediumHints);
    expect(tasks.find((t) => t.id === 'agent-system')).toBeDefined();
  });

  it('excludes agent-system for tiny repos', () => {
    const tasks = buildRepoReconTasks(smallHints);
    expect(tasks.find((t) => t.id === 'agent-system')).toBeUndefined();
  });

  it('includes docs-config only for non-tiny repos with hasDocs', () => {
    const withDocs = buildRepoReconTasks(mediumHints);
    expect(withDocs.find((t) => t.id === 'docs-config')).toBeDefined();

    const tinyWithDocs: RepoHints = { ...smallHints, hasDocs: true };
    const tinyTasks = buildRepoReconTasks(tinyWithDocs);
    expect(tinyTasks.find((t) => t.id === 'docs-config')).toBeUndefined();
  });

  it('adds code-quality catch-all for large repos with sparse domains', () => {
    // Only has 5 adaptive tasks (no TUI + no docs) → code-quality fills to 6
    const sparseLarge: RepoHints = {
      fileCount: 600,
      hasTui: false,
      hasTests: true,
      hasDocs: false,
      domains: ['typescript'],
    };
    const tasks = buildRepoReconTasks(sparseLarge);
    expect(tasks.find((t) => t.id === 'code-quality')).toBeDefined();
  });

  it('does not add code-quality for small repos', () => {
    const tasks = buildRepoReconTasks(smallHints);
    expect(tasks.find((t) => t.id === 'code-quality')).toBeUndefined();
  });

  it('each task has required fields', () => {
    const tasks = buildRepoReconTasks(largeHints);
    for (const task of tasks) {
      expect(task.id).toBeTruthy();
      expect(task.description).toBeTruthy();
      expect(task.scope).toBeTruthy();
      expect(Array.isArray(task.exclusions)).toBe(true);
      expect(task.expectedOutput).toBeTruthy();
    }
  });

  it('each task has non-empty exclusions array', () => {
    const tasks = buildRepoReconTasks(mediumHints);
    for (const task of tasks) {
      expect(task.exclusions.length).toBeGreaterThan(0);
    }
  });
});

// ─── normalizeDispatchPlan ───────────────────────────────────────────────────

describe('normalizeDispatchPlan', () => {
  const defaultHints: RepoHints = {
    fileCount: 100,
    hasTui: true,
    hasTests: true,
    hasDocs: true,
    domains: ['typescript'],
  };

  it('converts 1-agent parallel to delegated_single', () => {
    const result = normalizeDispatchPlan('orchestrate', 'parallel', 1, ['refactor auth'], defaultHints);
    expect(result.strategy).toBe('delegated_single');
    expect(result.agentCount).toBe(1);
    expect(result.uiLabel).toBe('Delegated · 1 agent');
  });

  it('expands single read-all task to repo reconnaissance', () => {
    const result = normalizeDispatchPlan('orchestrate', 'parallel', 1, ['read all the files and summarize'], defaultHints);
    expect(result.strategy).toBe('repo_reconnaissance');
    expect(result.agentCount).toBeGreaterThan(1);
  });

  it('passes through multi-agent parallel', () => {
    const result = normalizeDispatchPlan('subagent_parallel', 'parallel', 3, ['task1', 'task2', 'task3'], defaultHints);
    expect(result.strategy).toBe('subagent_parallel');
    expect(result.agentCount).toBe(3);
    expect(result.uiLabel).toContain('3 agents');
    expect(result.uiLabel).toContain('parallel');
  });

  it('returns inline for 0 agents', () => {
    const result = normalizeDispatchPlan('inline', undefined, 0, [], defaultHints);
    expect(result.strategy).toBe('inline');
    expect(result.agentCount).toBe(0);
    expect(result.uiLabel).toBe('Inline · no delegation');
  });

  it('sets usedFastPath for repo_reconnaissance strategy', () => {
    const result = normalizeDispatchPlan('repo_reconnaissance', undefined, 4, [], defaultHints);
    expect(result.strategy).toBe('repo_reconnaissance');
    expect(result.usedFastPath).toBe(true);
    expect(result.usedLlmPlanning).toBe(false);
  });

  it('sets usedFastPath for delegated_single', () => {
    const result = normalizeDispatchPlan('orchestrate', 'parallel', 1, ['fix the bug'], defaultHints);
    expect(result.strategy).toBe('delegated_single');
    expect(result.usedFastPath).toBe(true);
  });

  it('handles repo-recon read-all guard with hints', () => {
    const result = normalizeDispatchPlan(
      'orchestrate',
      'parallel',
      1,
      ['recursively read all source files and report architecture'],
      defaultHints,
    );
    expect(result.strategy).toBe('repo_reconnaissance');
    expect(result.agentCount).toBeGreaterThan(1);
  });

  it('labels sequential plans correctly', () => {
    const result = normalizeDispatchPlan('orchestrate', 'sequential', 3, ['s1', 's2', 's3'], defaultHints);
    expect(result.uiLabel).toContain('sequential');
  });
});
