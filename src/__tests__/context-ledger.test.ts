import { createContextLedger } from '../tools';

describe('context ledger', () => {
  it('starts empty', () => {
    const ledger = createContextLedger();
    expect(ledger.getCompact()).toBe('');
    expect(ledger.getExpanded()).toEqual({
      task: null,
      budget: { total: 0, used: 0, remaining: 0, approximate: true },
      instructionSources: [],
      files: [],
      commands: [],
      summaries: [],
      truncations: [],
      omissions: [],
    });
    expect(ledger.isSafe()).toBe(true);
  });

  it('tracks a task', () => {
    const ledger = createContextLedger();
    ledger.setTask('refactor auth module');
    expect(ledger.getExpanded().task).toBe('refactor auth module');
  });

  it('truncates long task in compact output', () => {
    const ledger = createContextLedger();
    const longTask = 'a'.repeat(100);
    ledger.setTask(longTask);
    const compact = ledger.getCompact();
    expect(compact).toContain('task: "');
    expect(compact).toContain('...');
  });

  it('sets budget and reports remaining', () => {
    const ledger = createContextLedger();
    ledger.setBudget(16000);
    expect(ledger.getExpanded().budget).toEqual({ total: 16000, used: 0, remaining: 16000, approximate: true });
    ledger.recordTokenUsage(4000);
    expect(ledger.getExpanded().budget.used).toBe(4000);
    expect(ledger.getExpanded().budget.remaining).toBe(12000);
    expect(ledger.isSafe()).toBe(true);
  });

  it('reports over-budget', () => {
    const ledger = createContextLedger();
    ledger.setBudget(1000);
    ledger.recordTokenUsage(1500);
    expect(ledger.isSafe()).toBe(false);
    expect(ledger.getExpanded().budget.remaining).toBe(0);
  });

  it('records instruction sources', () => {
    const ledger = createContextLedger();
    ledger.recordInstructionSource('system', { included: true });
    ledger.recordInstructionSource('developer', { included: true });
    ledger.recordInstructionSource('task', { included: true });
    const entry = ledger.getExpanded();
    expect(entry.instructionSources).toHaveLength(3);
    expect(entry.instructionSources[0].name).toBe('system');
    expect(entry.instructionSources[0].included).toBe(true);
  });

  it('records omitted instruction sources', () => {
    const ledger = createContextLedger();
    ledger.recordInstructionSource('developer', { omitted: true });
    const entry = ledger.getExpanded();
    expect(entry.instructionSources[0].omitted).toBe(true);
  });

  it('records file entries with line ranges', () => {
    const ledger = createContextLedger();
    ledger.recordFile('src/agent.ts', { lineRange: { start: 1, end: 50 }, approximateTokens: 200 });
    const entry = ledger.getExpanded();
    expect(entry.files).toHaveLength(1);
    expect(entry.files[0].path).toBe('src/agent.ts');
    expect(entry.files[0].lineRange).toEqual({ start: 1, end: 50 });
    expect(entry.files[0].approximateTokens).toBe(200);
  });

  it('records truncated files', () => {
    const ledger = createContextLedger();
    ledger.recordFile('src/large.ts', { truncated: true });
    const entry = ledger.getExpanded();
    expect(entry.files[0].truncated).toBe(true);
  });

  it('records summarized files', () => {
    const ledger = createContextLedger();
    ledger.recordFile('src/summary.ts', { summarized: true, approximateTokens: 50 });
    const entry = ledger.getExpanded();
    expect(entry.files[0].summarized).toBe(true);
  });

  it('records omitted files', () => {
    const ledger = createContextLedger();
    ledger.recordFile('src/omitted.ts', { omitted: true });
    const entry = ledger.getExpanded();
    expect(entry.files[0].omitted).toBe(true);
  });

  it('records command outputs', () => {
    const ledger = createContextLedger();
    ledger.recordCommand('git status --short', { truncated: true, approximateTokens: 100 });
    const entry = ledger.getExpanded();
    expect(entry.commands).toHaveLength(1);
    expect(entry.commands[0].command).toBe('git status --short');
    expect(entry.commands[0].truncated).toBe(true);
  });

  it('records summaries', () => {
    const ledger = createContextLedger();
    ledger.recordSummary('previous task', { approximateTokens: 300 });
    const entry = ledger.getExpanded();
    expect(entry.summaries).toHaveLength(1);
    expect(entry.summaries[0].source).toBe('previous task');
  });

  it('records truncations and omissions', () => {
    const ledger = createContextLedger();
    ledger.recordTruncation('src/large.ts', 'exceeded line limit');
    ledger.recordOmission('node_modules/pkg', 'blocked path');
    const entry = ledger.getExpanded();
    expect(entry.truncations).toHaveLength(1);
    expect(entry.truncations[0]).toEqual({ location: 'src/large.ts', reason: 'exceeded line limit' });
    expect(entry.omissions).toHaveLength(1);
    expect(entry.omissions[0]).toEqual({ location: 'node_modules/pkg', reason: 'blocked path' });
  });

  it('compact output includes all sections', () => {
    const ledger = createContextLedger();
    ledger.setTask('fix bug');
    ledger.setBudget(16000);
    ledger.recordInstructionSource('system');
    ledger.recordFile('src/a.ts', { lineRange: { start: 1, end: 10 } });
    ledger.recordCommand('git diff', { truncated: true });
    ledger.recordSummary('previous context');
    ledger.recordTruncation('src/large.ts', 'line limit');
    ledger.recordOmission('vendor/lib', 'blocked');
    ledger.recordTokenUsage(8000);

    const compact = ledger.getCompact();

    expect(compact).toContain('task: "fix bug"');
    expect(compact).toContain('16000');
    expect(compact).toContain('system');
    expect(compact).toContain('src/a.ts');
    expect(compact).toContain('git diff');
    expect(compact).toContain('previous context');
    expect(compact).toContain('truncations:');
    expect(compact).toContain('omitted:');
  });

  it('compact output shows budget warnings', () => {
    const ledger = createContextLedger();
    ledger.setBudget(1000);

    // Low budget warning
    ledger.recordTokenUsage(850);
    expect(ledger.getCompact()).toContain('low budget');

    // Over budget warning
    ledger.recordTokenUsage(1200);
    expect(ledger.getCompact()).toContain('over budget');
  });

  it('compact output groups included vs omitted', () => {
    const ledger = createContextLedger();
    ledger.recordInstructionSource('included-prompt', { included: true });
    ledger.recordInstructionSource('omitted-prompt', { omitted: true });
    ledger.recordFile('included.ts', { included: true });
    ledger.recordFile('omitted.ts', { omitted: true });

    const compact = ledger.getCompact();

    expect(compact).toContain('instructions:');
    expect(compact).toContain('instructions omitted:');
    expect(compact).toContain('files:');
    expect(compact).toContain('files omitted:');
  });

  it('compact output includes truncation flags', () => {
    const ledger = createContextLedger();
    ledger.recordFile('src/a.ts', { truncated: true });
    ledger.recordFile('src/b.ts', { summarized: true });

    const compact = ledger.getCompact();

    expect(compact).toContain('truncated');
    expect(compact).toContain('summary');
  });

  it('compact output includes approximate tokens', () => {
    const ledger = createContextLedger();
    ledger.recordFile('src/a.ts', { approximateTokens: 150 });
    ledger.recordCommand('echo hello', { approximateTokens: 30 });
    ledger.recordSummary('old context', { approximateTokens: 200 });

    const compact = ledger.getCompact();

    expect(compact).toContain('~150tok');
    expect(compact).toContain('~30tok');
    expect(compact).toContain('~200tok');
  });

  it('reset clears all state', () => {
    const ledger = createContextLedger();
    ledger.setTask('task');
    ledger.setBudget(16000);
    ledger.recordInstructionSource('system');
    ledger.recordFile('src/a.ts');
    ledger.recordCommand('git status');
    ledger.recordSummary('old');
    ledger.recordTokenUsage(5000);

    ledger.reset();

    expect(ledger.getCompact()).toBe('');
    expect(ledger.getExpanded().task).toBeNull();
    expect(ledger.getExpanded().budget.total).toBe(0);
    expect(ledger.getExpanded().instructionSources).toHaveLength(0);
    expect(ledger.getExpanded().files).toHaveLength(0);
    expect(ledger.getExpanded().commands).toHaveLength(0);
    expect(ledger.getExpanded().summaries).toHaveLength(0);
    expect(ledger.isSafe()).toBe(true);
  });

  it('compact output is empty when nothing recorded', () => {
    const ledger = createContextLedger();
    expect(ledger.getCompact()).toBe('');
  });
});
