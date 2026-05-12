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

    const dockTop = findLastIndex(lines, (line) => line.trimStart().startsWith('┌'));
    const dock = dockTop >= 0 ? lines.slice(dockTop) : [];

    expect(dock.length).toBeGreaterThan(4);
    expect(dock[0]?.trimStart().startsWith('┌')).toBe(true);
    expect(dock.at(-1)?.trimStart().startsWith('└ Enter submit')).toBe(true);
    expect(lines.join('\n')).toContain('TAIL_MARKER');
  });

  it('places the cursor on the typed text row instead of the padded dock row', () => {
    expect(inputCursorPosition('hi synax', 80, 24)).toEqual({ row: 21, col: 11 });
  });

  it('places the cursor after trailing input spaces', () => {
    expect(inputCursorPosition('hi synax   ', 80, 24)).toEqual({ row: 21, col: 14 });
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
    expect(cursor.col).toBe(lines[cursor.row].indexOf('TAIL_MARKER') + 'TAIL_MARKER'.length);
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
  return input.replace(/\u001b\[[0-9;]*m/g, '');
}
