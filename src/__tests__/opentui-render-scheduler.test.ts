import {
  AdaptiveRenderScheduler,
  IncrementalFeedModel,
  DEFAULT_LIVE_CARD_LIMIT,
  applyFeedOperations,
} from '../tui/opentui-render-scheduler';
import type { SemanticEvent } from '../tui/semantic-events';

function event(id: string, body = id): SemanticEvent {
  return {
    id,
    class: 'assistant_text',
    timestamp: 0,
    artifact: { type: 'text', title: 'Note', body },
    metadata: {},
  };
}

describe('OpenTUI incremental feed model', () => {
  it('appends initial cards without removals', () => {
    const model = new IncrementalFeedModel();

    const plan = model.plan([event('a'), event('b')]);

    expect(plan.operations.map((op) => op.type)).toEqual(['append', 'append']);
    expect(plan.visibleIds).toEqual(['a', 'b']);
  });

  it('appends only repeated new cards', () => {
    const model = new IncrementalFeedModel();
    model.plan([event('a')]);

    const plan = model.plan([event('a'), event('b'), event('c')]);

    expect(plan.operations).toEqual([
      { type: 'append', id: 'b', event: expect.objectContaining({ id: 'b' }) },
      { type: 'append', id: 'c', event: expect.objectContaining({ id: 'c' }) },
    ]);
  });

  it('updates a duplicate id when the event object or expanded state changes', () => {
    const model = new IncrementalFeedModel();
    const first = event('a', 'old');
    model.plan([first]);

    const changedEvent = model.plan([event('a', 'new')]);

    expect(changedEvent.operations).toEqual([
      { type: 'update', id: 'a', event: expect.objectContaining({ id: 'a' }), index: 0 },
    ]);
  });

  it('moves an existing card when a new card is inserted before it', () => {
    const model = new IncrementalFeedModel();
    model.plan([event('thinking')]);

    const plan = model.plan([event('prompt'), event('thinking')]);

    expect(plan.operations).toEqual([
      { type: 'append', id: 'prompt', event: expect.objectContaining({ id: 'prompt' }) },
      { type: 'update', id: 'thinking', event: expect.objectContaining({ id: 'thinking' }), index: 1 },
    ]);
    expect(plan.visibleIds).toEqual(['prompt', 'thinking']);
  });

  it('caps live cards and removes old rendered nodes', () => {
    const model = new IncrementalFeedModel(2);
    model.plan([event('a'), event('b')]);

    const plan = model.plan([event('a'), event('b'), event('c')]);

    expect(plan.operations.map((op) => `${op.type}:${op.id}`)).toEqual(['remove:a', 'append:c']);
    expect(plan.visibleIds).toEqual(['b', 'c']);
  });

  it('uses a conservative default live-card limit', () => {
    expect(DEFAULT_LIVE_CARD_LIMIT).toBeGreaterThanOrEqual(200);
    expect(DEFAULT_LIVE_CARD_LIMIT).toBeLessThanOrEqual(500);
  });
});

describe('applyFeedOperations', () => {
  interface FakeContainer {
    children: string[];
    add(node: unknown, index?: number): void;
  }

  function makeContainer(initial: string[]): FakeContainer {
    return {
      children: [...initial],
      add(node: unknown, index?: number): void {
        const id = node as string;
        if (index === undefined) this.children.push(id);
        else this.children.splice(index, 0, id);
      },
    };
  }

  function removeFrom(container: FakeContainer): (id: string) => void {
    return (id) => {
      const idx = container.children.indexOf(id);
      if (idx >= 0) container.children.splice(idx, 1);
    };
  }

  it('re-inserts an updated card at its original position', () => {
    const model = new IncrementalFeedModel();
    model.plan([event('prompt'), event('thinking', 'old')]);
    const container = makeContainer(['prompt', 'thinking']);

    const plan = model.plan([event('prompt'), event('thinking', 'new')]);
    applyFeedOperations(plan, container, removeFrom(container), (e) => e.id);

    expect(container.children).toEqual(['prompt', 'thinking']);
  });

  it('respects a card index offset for non-event header children', () => {
    const model = new IncrementalFeedModel();
    model.plan([event('prompt'), event('tool'), event('thinking', 'old')]);
    // Session header card occupies slot 0 of the real ScrollBox.
    const container = makeContainer(['header', 'prompt', 'tool', 'thinking']);

    // Streaming reasoning delta updates the thinking card body.
    const plan = model.plan([event('prompt'), event('tool'), event('thinking', 'new')]);
    applyFeedOperations(plan, container, removeFrom(container), (e) => e.id, 1);

    // Without the offset the thinking card would land above the tool card.
    expect(container.children).toEqual(['header', 'prompt', 'tool', 'thinking']);
  });

  it('appends new cards at the end regardless of offset', () => {
    const model = new IncrementalFeedModel();
    model.plan([event('prompt')]);
    const container = makeContainer(['header', 'prompt']);

    const plan = model.plan([event('prompt'), event('thinking')]);
    applyFeedOperations(plan, container, removeFrom(container), (e) => e.id, 1);

    expect(container.children).toEqual(['header', 'prompt', 'thinking']);
  });

  it('removes cards that left the feed', () => {
    const model = new IncrementalFeedModel();
    model.plan([event('thinking'), event('prompt')]);
    const container = makeContainer(['header', 'thinking', 'prompt']);

    const plan = model.plan([event('prompt')]);
    applyFeedOperations(plan, container, removeFrom(container), (e) => e.id, 1);

    expect(container.children).toEqual(['header', 'prompt']);
  });
});

describe('OpenTUI adaptive render scheduler', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('coalesces frequent semantic updates into one render', () => {
    const flush = jest.fn();
    const scheduler = new AdaptiveRenderScheduler(flush, { coalesceMs: 75, maxFps: 60 });

    scheduler.markDirty('semantic');
    scheduler.markDirty('semantic');
    scheduler.markDirty('status');
    jest.advanceTimersByTime(74);
    expect(flush).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('does not schedule frames while idle', () => {
    const flush = jest.fn();
    const scheduler = new AdaptiveRenderScheduler(flush, { coalesceMs: 75, maxFps: 60 });

    scheduler.tickIdle();
    scheduler.tickIdle();
    jest.runOnlyPendingTimers();

    expect(flush).not.toHaveBeenCalled();
    expect(scheduler.getStats().skippedIdleFrames).toBe(2);
  });
});
