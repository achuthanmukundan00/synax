import { createInitialRunStateSnapshot } from '../agent/tui-state';
import { inputCursorPosition, renderLayout } from '../tui/layout';

describe('layout input dock', () => {
  it('expands beyond two lines and keeps latest text visible', () => {
    const objectiveInput = `${'expand the prompt dock '.repeat(22)}TAIL_MARKER`;
    const lines = renderLayout(
      {
        run: createInitialRunStateSnapshot(0),
        objectiveInput,
        coreMode: 'idle',
        nowMs: 2000,
      },
      90,
      24,
    ).map(stripAnsi);

    // Find the dock by the hr line (starts with dashes after all content)
    const dockTop = findLastIndex(lines, (line) => line.trimStart().startsWith('─'));
    const dock = dockTop >= 0 ? lines.slice(dockTop) : [];

    expect(dock.length).toBeGreaterThan(2);
    expect(dock[0]?.trimStart().startsWith('─')).toBe(true);
    expect(dock[1]?.trimStart().startsWith('>')).toBe(true);
    expect(lines.join('\n')).toContain('TAIL_MARKER');
  });

  it('places the cursor on the typed text row instead of the padded dock row', () => {
    expect(inputCursorPosition('hi synax', 80, 24)).toEqual({ row: 22, col: 10 });
  });

  it('places the cursor after trailing input spaces', () => {
    expect(inputCursorPosition('hi synax   ', 80, 24)).toEqual({ row: 22, col: 13 });
  });

  it('places the cursor on the final visible wrapped input line', () => {
    const objectiveInput = `${'expand the prompt dock '.repeat(8)}TAIL_MARKER`;
    const lines = renderLayout(
      {
        run: createInitialRunStateSnapshot(0),
        objectiveInput,
        coreMode: 'idle',
        nowMs: 2000,
      },
      54,
      18,
    ).map(stripAnsi);
    const cursor = inputCursorPosition(objectiveInput, 54, 18);

    expect(lines[cursor.row]).toContain('TAIL_MARKER');
    // Continuation line has no prefix, so cursor col = TAIL_MARKER position + length (both 0 and 11)
    const tailIndex = lines[cursor.row].indexOf('TAIL_MARKER');
    expect(tailIndex).toBe(0);
    expect(cursor.col).toBe(0 + 'TAIL_MARKER'.length);
    expect(lines[cursor.row].trimEnd()).toBe('TAIL_MARKER');
  });
});

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) return index;
  }
  return -1;
}

function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\[[0-9;]*m/g, '');
}
