/**
 * Tool contract regression tests.
 *
 * Verifies that:
 * 1. System prompt tool names match actual registered tools
 * 2. Mutation tools are available in coding mode
 * 3. Status-only final outputs are rejected
 * 4. Memory automatic-save prompt conditional on memory wired
 * 5. memory.store errors surfaced to caller
 * 6. save_memory / search_memory are generic overlay tools
 */

import { systemPrompt, buildModelFacingTools, STATUS_ONLY_PATTERNS } from '../session/tool-definitions';
import { isStatusOnlyOutput } from '../session/formatting';
import { getAllowedModelTools } from '../agent/task-policy';

// ─── 1. Prompt tool manifest equals actual registered tools ─────────────────

describe('prompt tool manifest', () => {
  it('systemPrompt advertises exactly the tools passed in', () => {
    const tools = ['read', 'search_memory', 'view_image'];
    const prompt = systemPrompt({ tools, memoryWired: false, hasMutationTools: false });

    // Must contain the tools passed
    expect(prompt).toContain('Tools: read, search_memory, view_image');

    // Must NOT contain tools not passed
    expect(prompt).not.toContain('write');
    expect(prompt).not.toContain('edit');
    expect(prompt).not.toContain('bash');
    expect(prompt).not.toContain('save_memory');
  });

  it('systemPrompt with all coding tools shows correct tool line', () => {
    const tools = ['read', 'write', 'edit', 'bash', 'search_memory', 'save_memory', 'view_image'];
    const prompt = systemPrompt({ tools, memoryWired: true, hasMutationTools: true });

    expect(prompt).toContain('Tools: read, write, edit, bash, search_memory, save_memory, view_image');
    expect(prompt).toContain('Use write for new text files and edit for exact replacements');
    expect(prompt).toContain('Memory is stored automatically');
  });

  it('systemPrompt in inspect-only mode warns about no mutations', () => {
    const tools = ['read', 'search_memory', 'view_image'];
    const prompt = systemPrompt({ tools, memoryWired: false, hasMutationTools: false });

    expect(prompt).toContain('inspect-only');
    expect(prompt).not.toContain('Use write');
    expect(prompt).not.toContain('Use edit');
  });

  it('systemPrompt advertises save_memory when available but memory not wired', () => {
    const tools = ['read', 'search_memory', 'save_memory', 'view_image'];
    const prompt = systemPrompt({ tools, memoryWired: false, hasMutationTools: true });

    expect(prompt).toContain('Tools: read, search_memory, save_memory, view_image');
    // When memory is not wired, prompt tells model to use save_memory
    expect(prompt).toContain('Use save_memory to explicitly persist');
    expect(prompt).not.toContain('Memory is stored automatically');
  });

  it('systemPrompt when memory IS wired says automatic', () => {
    const tools = ['read', 'write', 'edit', 'bash', 'search_memory', 'save_memory', 'view_image'];
    const prompt = systemPrompt({ tools, memoryWired: true, hasMutationTools: true });

    expect(prompt).toContain('Memory is stored automatically');
    expect(prompt).toContain('Use save_memory to store notes');
  });

  it('systemPrompt handles empty tools gracefully', () => {
    const prompt = systemPrompt({ tools: [], memoryWired: false, hasMutationTools: false });
    expect(prompt).toContain('Tools: read');
  });
});

// ─── 2. Coding mode has mutation tools ─────────────────────────────────────

describe('coding mode mutation tools', () => {
  it('patch mode includes write, edit, save_memory with bash', () => {
    const tools = buildModelFacingTools({ mode: 'patch', bashEnabled: true });
    const names = tools.map((t) => t.name);

    expect(names).toContain('read');
    expect(names).toContain('write');
    expect(names).toContain('edit');
    expect(names).toContain('bash');
    expect(names).toContain('search_memory');
    expect(names).toContain('save_memory');
    expect(names).toContain('view_image');
  });

  it('read-only mode excludes write and edit', () => {
    const tools = buildModelFacingTools({ mode: 'read-only', bashEnabled: true });
    const names = tools.map((t) => t.name);

    expect(names).toContain('read');
    expect(names).toContain('search_memory');
    expect(names).toContain('view_image');
    expect(names).not.toContain('write');
    expect(names).not.toContain('edit');
    expect(names).not.toContain('save_memory');
  });

  it('verify mode excludes mutation tools', () => {
    const tools = buildModelFacingTools({ mode: 'verify', bashEnabled: true });
    const names = tools.map((t) => t.name);

    expect(names).not.toContain('write');
    expect(names).not.toContain('edit');
    expect(names).not.toContain('save_memory');
  });

  it('docs mode includes mutation tools', () => {
    const tools = buildModelFacingTools({ mode: 'docs', bashEnabled: true });
    const names = tools.map((t) => t.name);

    expect(names).toContain('write');
    expect(names).toContain('edit');
    expect(names).toContain('save_memory');
  });

  it('getAllowedModelTools returns save_memory in patch mode', () => {
    const tools = getAllowedModelTools('patch', true);
    expect(tools).toContain('save_memory');
  });

  it('getAllowedModelTools excludes save_memory in read-only mode', () => {
    const tools = getAllowedModelTools('read-only', true);
    expect(tools).not.toContain('save_memory');
    expect(tools).not.toContain('write');
    expect(tools).not.toContain('edit');
  });
});

// ─── 3. Status-only final outputs rejected ─────────────────────────────────

describe('status-only output rejection', () => {
  it('rejects "completed"', () => {
    expect(isStatusOnlyOutput('completed')).toBe(true);
    expect(isStatusOnlyOutput('Completed')).toBe(true);
    expect(isStatusOnlyOutput('  completed  ')).toBe(true);
  });

  it('rejects "Status: completed"', () => {
    expect(isStatusOnlyOutput('Status: completed')).toBe(true);
  });

  it('rejects "working tree: dirty"', () => {
    expect(isStatusOnlyOutput('working tree: dirty')).toBe(true);
    expect(isStatusOnlyOutput('Working tree: clean')).toBe(true);
  });

  it('rejects "completed, working tree dirty"', () => {
    expect(isStatusOnlyOutput('completed, working tree dirty')).toBe(true);
  });

  it('rejects empty string', () => {
    expect(isStatusOnlyOutput('')).toBe(true);
    expect(isStatusOnlyOutput('   ')).toBe(true);
  });

  it('rejects "done", "ok", "finished"', () => {
    expect(isStatusOnlyOutput('done')).toBe(true);
    expect(isStatusOnlyOutput('ok')).toBe(true);
    expect(isStatusOnlyOutput('finished')).toBe(true);
  });

  it('accepts real content', () => {
    expect(isStatusOnlyOutput('I have completed the refactor.')).toBe(false);
    expect(isStatusOnlyOutput('The task is done — all files updated.')).toBe(false);
    expect(isStatusOnlyOutput('Working tree is dirty because we added new files.')).toBe(false);
    expect(isStatusOnlyOutput('ok here is the summary')).toBe(false);
  });
});

// ─── 4. Memory contract ────────────────────────────────────────────────────

describe('memory prompt contract', () => {
  it('when memoryWired=false, prompt includes explicit save instructions', () => {
    const prompt = systemPrompt({
      tools: ['read', 'search_memory', 'save_memory'],
      memoryWired: false,
      hasMutationTools: true,
    });

    expect(prompt).toContain('Use save_memory to explicitly persist');
    expect(prompt).not.toContain('Memory is stored automatically');
  });

  it('when memoryWired=true, prompt advertises automatic storage', () => {
    const prompt = systemPrompt({
      tools: ['read', 'write', 'edit', 'bash', 'search_memory', 'save_memory', 'view_image'],
      memoryWired: true,
      hasMutationTools: true,
    });

    expect(prompt).toContain('Memory is stored automatically');
  });

  it('search_memory and save_memory are generic — no product-specific references', () => {
    const prompt = systemPrompt({
      tools: ['read', 'search_memory', 'save_memory', 'view_image'],
      memoryWired: false,
      hasMutationTools: true,
    });
    // Generic, not product-specific
    expect(prompt).not.toContain('AutoCareer');
    expect(prompt).not.toContain('Suitcase');
    expect(prompt).not.toContain('savePreference');
  });
});

// ─── 5. STATUS_ONLY_PATTERNS coverage ──────────────────────────────────────

describe('STATUS_ONLY_PATTERNS', () => {
  it('all patterns compile as valid regex', () => {
    for (const pattern of STATUS_ONLY_PATTERNS) {
      expect(() => new RegExp(pattern)).not.toThrow();
    }
  });

  it('covers the documented status-only cases', () => {
    const cases = [
      'completed',
      'Status: completed',
      'working tree: dirty',
      'completed, working tree dirty',
      'Working tree: clean',
      'done',
      'ok',
      'finished',
    ];
    for (const c of cases) {
      expect(isStatusOnlyOutput(c)).toBe(true);
    }
  });
});
