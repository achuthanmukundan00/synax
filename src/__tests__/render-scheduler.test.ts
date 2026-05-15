import { AdaptiveRenderScheduler, IncrementalFeedModel, DEFAULT_LIVE_CARD_LIMIT } from '../tui/render-scheduler';
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

describe('incremental feed model', () => {
  it('appends initial cards without removals', () => {
    const model = new IncrementalFeedModel();

    const plan = model.plan([event('a'), event('b')], {});

    expect(plan.operations.map((op) => op.type)).toEqual(['append', 'append']);
    expect(plan.visibleIds).toEqual(['a', 'b']);
  });

  it('appends only repeated new cards', () => {
    const model = new IncrementalFeedModel();
    model.plan([event('a')], {});

    const plan = model.plan([event('a'), event('b'), event('c')], {});

    expect(plan.operations).toEqual([
      { type: 'append', id: 'b', event: expect.objectContaining({ id: 'b' }) },
      { type: 'append', id: 'c', event: expect.objectContaining({ id: 'c' }) },
    ]);
  });

  it('updates a duplicate id when the event object or expanded state changes', () => {
    const model = new IncrementalFeedModel();
    const first = event('a', 'old');
    model.plan([first], {});

    const changedEvent = model.plan([event('a', 'new')], {});
    const changedExpansion = model.plan([event('a', 'new')], { a: true });

    expect(changedEvent.operations).toEqual([
      { type: 'update', id: 'a', event: expect.objectContaining({ id: 'a' }), index: 0 },
    ]);
    expect(changedExpansion.operations).toEqual([
      { type: 'update', id: 'a', event: expect.objectContaining({ id: 'a' }), index: 0 },
    ]);
  });

  it('caps live cards and removes old rendered nodes', () => {
    const model = new IncrementalFeedModel(2);
    model.plan([event('a'), event('b')], {});

    const plan = model.plan([event('a'), event('b'), event('c')], {});

    expect(plan.operations.map((op) => `${op.type}:${op.id}`)).toEqual(['remove:a', 'append:c']);
    expect(plan.visibleIds).toEqual(['b', 'c']);
  });

  it('uses a conservative default live-card limit', () => {
    expect(DEFAULT_LIVE_CARD_LIMIT).toBeGreaterThanOrEqual(200);
    expect(DEFAULT_LIVE_CARD_LIMIT).toBeLessThanOrEqual(500);
  });
});

describe('adaptive render scheduler', () => {
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
