import { createGeneratedContentStore, createInspectionLedger, createToolRegistry } from '../tools';

describe('generated-content store', () => {
  it('stores and retrieves content by id', () => {
    const store = createGeneratedContentStore();
    store.store('cmd:git-diff', 'line1\nline2\nline3\n');

    expect(store.has('cmd:git-diff')).toBe(true);
    expect(store.has('nonexistent')).toBe(false);
    expect(store.list()).toEqual(['cmd:git-diff']);
  });

  it('retrieves content by line range', () => {
    const store = createGeneratedContentStore();
    store.store('cmd:git-diff', 'line1\nline2\nline3\nline4\nline5\n');

    const range = store.getRange('cmd:git-diff', 2, 4);
    expect(range).not.toBeNull();
    expect(range!.contentId).toBe('cmd:git-diff');
    expect(range!.totalLines).toBe(5);
    expect(range!.lines).toEqual([
      { lineNumber: 2, text: 'line2' },
      { lineNumber: 3, text: 'line3' },
      { lineNumber: 4, text: 'line4' },
    ]);
    expect(range!.truncated).toBe(false);
    expect(range!.startBeyondEnd).toBe(false);
  });

  it('handles single-line retrieval', () => {
    const store = createGeneratedContentStore();
    store.store('file:src/a.ts', 'alpha\nbeta\ngamma\n');

    const range = store.getRange('file:src/a.ts', 2, 2);
    expect(range!.lines).toEqual([{ lineNumber: 2, text: 'beta' }]);
    expect(range!.totalLines).toBe(3);
  });

  it('returns null for unknown id', () => {
    const store = createGeneratedContentStore();
    expect(store.getRange('unknown', 1, 10)).toBeNull();
  });

  it('handles range extending beyond stored content', () => {
    const store = createGeneratedContentStore();
    store.store('cmd:output', 'a\nb\nc\n');

    const range = store.getRange('cmd:output', 2, 10);
    expect(range!.lines).toEqual([
      { lineNumber: 2, text: 'b' },
      { lineNumber: 3, text: 'c' },
    ]);
    expect(range!.truncated).toBe(true);
    expect(range!.startBeyondEnd).toBe(false);
    expect(range!.totalLines).toBe(3);
  });

  it('handles startLine beyond stored content length', () => {
    const store = createGeneratedContentStore();
    store.store('cmd:output', 'a\nb\n');

    const range = store.getRange('cmd:output', 5, 10);
    expect(range!.lines).toEqual([]);
    expect(range!.startBeyondEnd).toBe(true);
    expect(range!.truncated).toBe(false);
    expect(range!.totalLines).toBe(2);
  });

  it('replaces content with same id', () => {
    const store = createGeneratedContentStore();
    store.store('key', 'old');
    store.store('key', 'new content');
    expect(store.list()).toEqual(['key']);
    const range = store.getRange('key', 1, 1);
    expect(range!.lines[0].text).toBe('new content');
  });

  it('removes content by id', () => {
    const store = createGeneratedContentStore();
    store.store('a', 'content a');
    store.store('b', 'content b');
    store.remove('a');

    expect(store.has('a')).toBe(false);
    expect(store.has('b')).toBe(true);
    expect(store.list()).toEqual(['b']);
  });

  it('resets all content', () => {
    const store = createGeneratedContentStore();
    store.store('a', 'content');
    store.store('b', 'content');
    store.reset();

    expect(store.list()).toEqual([]);
    expect(store.has('a')).toBe(false);
  });

  it('handles empty content', () => {
    const store = createGeneratedContentStore();
    store.store('empty', '');

    expect(store.has('empty')).toBe(true);
    const range = store.getRange('empty', 1, 5);
    expect(range!.lines).toEqual([]);
    expect(range!.totalLines).toBe(0);
    expect(range!.startBeyondEnd).toBe(true);
  });

  it('handles content with trailing newline', () => {
    const store = createGeneratedContentStore();
    store.store('with-trailing', 'alpha\nbeta\n');

    const range = store.getRange('with-trailing', 1, 2);
    expect(range!.totalLines).toBe(2);
    expect(range!.lines).toEqual([
      { lineNumber: 1, text: 'alpha' },
      { lineNumber: 2, text: 'beta' },
    ]);
  });

  it('handles Windows-style line endings', () => {
    const store = createGeneratedContentStore();
    store.store('win', 'line1\r\nline2\r\nline3');

    const range = store.getRange('win', 2, 3);
    expect(range!.totalLines).toBe(3);
    expect(range!.lines).toEqual([
      { lineNumber: 2, text: 'line2' },
      { lineNumber: 3, text: 'line3' },
    ]);
  });

  it('stores with approximate token count', () => {
    const store = createGeneratedContentStore();
    store.store('key', 'content', { approximateTokens: 42 });
    expect(store.has('key')).toBe(true);
    const range = store.getRange('key', 1, 1);
    expect(range!.lines[0].text).toBe('content');
  });

  it('lists ids in alphabetical order', () => {
    const store = createGeneratedContentStore();
    store.store('c', 'c');
    store.store('a', 'a');
    store.store('b', 'b');
    expect(store.list()).toEqual(['a', 'b', 'c']);
  });
});

describe('context_range_paste tool', () => {
  it('is registered in the inspection tool set', () => {
    const registry = createToolRegistry({ repoRoot: '/tmp/test' });

    expect(registry.list().map((t) => t.name)).toContain('context_range_paste');
  });

  it('has read-only safety policy', () => {
    const registry = createToolRegistry({ repoRoot: '/tmp/test' });

    const tool = registry.get('context_range_paste');
    expect(tool?.safetyPolicy.readOnly).toBe(true);
    expect(tool?.safetyPolicy.boundedOutput).toBe(true);
  });

  it('has correct ledger behavior', () => {
    const registry = createToolRegistry({ repoRoot: '/tmp/test' });

    const tool = registry.get('context_range_paste');
    expect(tool?.ledgerBehavior).toBe('records-pasted-range');
  });

  it('validates required input fields', async () => {
    const store = createGeneratedContentStore();
    store.store('content-1', 'line1\nline2\n');
    const registry = createToolRegistry({ repoRoot: '/tmp/test', generatedContent: store });

    await expect(registry.execute('context_range_paste', {} as unknown)).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('contentId is required'),
    });
  });

  it('returns error when no generated-content store is available', async () => {
    const registry = createToolRegistry({ repoRoot: '/tmp/test' });

    await expect(
      registry.execute('context_range_paste', { contentId: 'some-id', startLine: 1, endLine: 10 }),
    ).resolves.toMatchObject({
      success: false,
      error: 'generated-content store is not available',
    });
  });

  it('returns error for unknown content id', async () => {
    const store = createGeneratedContentStore();
    const registry = createToolRegistry({ repoRoot: '/tmp/test', generatedContent: store });

    await expect(
      registry.execute('context_range_paste', { contentId: 'nonexistent', startLine: 1, endLine: 5 }),
    ).resolves.toMatchObject({
      success: false,
      error: 'unknown content id: nonexistent',
    });
  });

  it('pastes a bounded line range from stored content', async () => {
    const store = createGeneratedContentStore();
    store.store('cmd:test', 'one\ntwo\nthree\nfour\nfive\n');
    const registry = createToolRegistry({ repoRoot: '/tmp/test', generatedContent: store });

    const result = await registry.execute('context_range_paste', {
      contentId: 'cmd:test',
      startLine: 2,
      endLine: 4,
    });

    expect(result.success).toBe(true);
    expect(result.output).toEqual({
      contentId: 'cmd:test',
      startLine: 2,
      endLine: 4,
      totalLines: 5,
      lines: [
        { lineNumber: 2, text: 'two' },
        { lineNumber: 3, text: 'three' },
        { lineNumber: 4, text: 'four' },
      ],
      truncated: false,
    });
  });

  it('pastes a single line', async () => {
    const store = createGeneratedContentStore();
    store.store('cmd:test', 'alpha\nbeta\n');
    const registry = createToolRegistry({ repoRoot: '/tmp/test', generatedContent: store });

    const result = await registry.execute('context_range_paste', {
      contentId: 'cmd:test',
      startLine: 1,
      endLine: 1,
    });

    expect(result.success).toBe(true);
    expect(result.output).toEqual({
      contentId: 'cmd:test',
      startLine: 1,
      endLine: 1,
      totalLines: 2,
      lines: [{ lineNumber: 1, text: 'alpha' }],
      truncated: false,
    });
  });

  it('clamps endLine to stored content length and reports truncation', async () => {
    const store = createGeneratedContentStore();
    store.store('cmd:test', 'a\nb\nc\n');
    const registry = createToolRegistry({ repoRoot: '/tmp/test', generatedContent: store });

    const result = await registry.execute('context_range_paste', {
      contentId: 'cmd:test',
      startLine: 2,
      endLine: 20,
    });

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({
      contentId: 'cmd:test',
      startLine: 2,
      endLine: 3,
      totalLines: 3,
      truncated: true,
    });
    expect(result.output).not.toHaveProperty('startBeyondEnd');
  });

  it('returns empty lines when startLine exceeds content length', async () => {
    const store = createGeneratedContentStore();
    store.store('cmd:test', 'a\nb\n');
    const registry = createToolRegistry({ repoRoot: '/tmp/test', generatedContent: store });

    const result = await registry.execute('context_range_paste', {
      contentId: 'cmd:test',
      startLine: 10,
      endLine: 15,
    });

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({
      contentId: 'cmd:test',
      startLine: 10,
      endLine: 15,
      totalLines: 2,
      lines: [],
      startBeyondEnd: true,
    });
    expect(result.output).toHaveProperty('note');
    expect((result.output as Record<string, unknown>).note).toContain('exceeds stored content length');
  });

  it('records pasted lines in the inspection ledger', async () => {
    const store = createGeneratedContentStore();
    store.store('content-1', 'line1\nline2\nline3\n');
    const ledger = createInspectionLedger();
    const registry = createToolRegistry({ repoRoot: '/tmp/test', generatedContent: store, ledger });

    await registry.execute('context_range_paste', {
      contentId: 'content-1',
      startLine: 1,
      endLine: 2,
    });

    // Ledger should record the generated-content reads
    expect(ledger.hasInspectedFile('generated:content-1')).toBe(true);
    expect(ledger.hasReadText('generated:content-1', 'line1')).toBe(true);
    expect(ledger.hasReadText('generated:content-1', 'line2')).toBe(true);
  });

  it('does not record ledger entries when startLine exceeds content length', async () => {
    const store = createGeneratedContentStore();
    store.store('content-1', 'a\n');
    const ledger = createInspectionLedger();
    const registry = createToolRegistry({ repoRoot: '/tmp/test', generatedContent: store, ledger });

    await registry.execute('context_range_paste', {
      contentId: 'content-1',
      startLine: 5,
      endLine: 10,
    });

    // No ledger entries since no lines were pasted
    expect(ledger.hasInspectedFile('generated:content-1')).toBe(false);
  });

  it('defaults startLine to 1 and endLine to startLine when not provided', async () => {
    const store = createGeneratedContentStore();
    store.store('content-1', 'only line\n');
    const registry = createToolRegistry({ repoRoot: '/tmp/test', generatedContent: store });

    // When neither startLine nor endLine are provided, defaults apply
    const result = await registry.execute('context_range_paste', {
      contentId: 'content-1',
    });

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({
      contentId: 'content-1',
      startLine: 1,
      endLine: 1,
      totalLines: 1,
    });
  });

  it('handles camelCase to snake_case name normalization', async () => {
    const store = createGeneratedContentStore();
    store.store('content-1', 'a\n');
    const registry = createToolRegistry({ repoRoot: '/tmp/test', generatedContent: store });

    const result = await registry.execute('contextRangePaste', {
      contentId: 'content-1',
      startLine: 1,
      endLine: 1,
    });

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ contentId: 'content-1' });
  });

  it('handles input validation for non-object input', async () => {
    const registry = createToolRegistry({ repoRoot: '/tmp/test' });

    await expect(registry.execute('context_range_paste', null)).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('input must be an object'),
    });
  });
});
