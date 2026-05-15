import type { SemanticEvent } from './semantic-events';

export const DEFAULT_LIVE_CARD_LIMIT = 300;
export const CMUX_LIVE_CARD_LIMIT = 150;
export const DEFAULT_TUI_COALESCE_MS = 60;
export const CMUX_TUI_COALESCE_MS = 100;
export const DEFAULT_ACTIVE_FPS = 60;
export const CMUX_ACTIVE_FPS = 20;

export interface FeedRenderOperation {
  type: 'append' | 'update' | 'remove';
  event?: SemanticEvent;
  id: string;
  index?: number;
}

export interface FeedRenderPlan {
  operations: FeedRenderOperation[];
  visibleIds: string[];
}

interface RenderedCardState {
  event: SemanticEvent;
  expanded: boolean;
  signature: string;
}

export class IncrementalFeedModel {
  private readonly rendered = new Map<string, RenderedCardState>();
  private order: string[] = [];

  constructor(private readonly liveCardLimit = DEFAULT_LIVE_CARD_LIMIT) {}

  plan(events: SemanticEvent[], expanded: Record<string, boolean>): FeedRenderPlan {
    const limited = events.slice(Math.max(0, events.length - this.liveCardLimit));
    const nextIds = limited.map((event) => event.id);
    const nextIdSet = new Set(nextIds);
    const operations: FeedRenderOperation[] = [];

    for (const id of this.order) {
      if (!nextIdSet.has(id)) {
        operations.push({ type: 'remove', id });
        this.rendered.delete(id);
      }
    }

    const nextOrder: string[] = [];
    for (const event of limited) {
      const isExpanded = expanded[event.id] ?? false;
      const previous = this.rendered.get(event.id);
      const signature = eventSignature(event);
      nextOrder.push(event.id);
      if (!previous) {
        operations.push({ type: 'append', id: event.id, event });
        this.rendered.set(event.id, { event, expanded: isExpanded, signature });
        continue;
      }
      if (previous.signature !== signature || previous.expanded !== isExpanded) {
        operations.push({ type: 'update', id: event.id, event, index: nextOrder.length - 1 });
        this.rendered.set(event.id, { event, expanded: isExpanded, signature });
      }
    }

    this.order = nextOrder;
    return { operations, visibleIds: [...this.order] };
  }

  reset(): void {
    this.rendered.clear();
    this.order = [];
  }
}

function eventSignature(event: SemanticEvent): string {
  return JSON.stringify({
    class: event.class,
    artifact: event.artifact,
    metadata: event.metadata,
    parentId: event.parentId,
  });
}

export type DirtyReason =
  | 'semantic'
  | 'status'
  | 'completion'
  | 'error'
  | 'approval'
  | 'input'
  | 'scroll'
  | 'resize'
  | 'layout'
  | 'animation';

export interface AdaptiveRenderSchedulerStats {
  renderedFrames: number;
  skippedIdleFrames: number;
  averageActiveFrameIntervalMs: number;
}

export class AdaptiveRenderScheduler {
  private dirty = false;
  private pending = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastFrameAt = 0;
  private totalFrameInterval = 0;
  private frameIntervalSamples = 0;
  private stats: AdaptiveRenderSchedulerStats = {
    renderedFrames: 0,
    skippedIdleFrames: 0,
    averageActiveFrameIntervalMs: 0,
  };

  constructor(
    private readonly flush: () => void,
    private readonly options: { coalesceMs: number; maxFps: number },
  ) {}

  markDirty(reason: DirtyReason, options?: { immediate?: boolean }): void {
    this.dirty = true;
    const immediate = options?.immediate === true || isPromptReason(reason);
    this.schedule(immediate ? 0 : this.options.coalesceMs);
  }

  tickIdle(): void {
    if (!this.dirty && !this.pending) {
      this.stats.skippedIdleFrames++;
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = false;
    this.dirty = false;
  }

  getStats(): AdaptiveRenderSchedulerStats {
    return { ...this.stats };
  }

  private schedule(delayMs: number): void {
    if (this.pending) return;
    const now = Date.now();
    const minFrameDelay = Math.max(0, Math.floor(1000 / Math.max(1, this.options.maxFps)) - (now - this.lastFrameAt));
    const delay = Math.max(delayMs, minFrameDelay);
    this.pending = true;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pending = false;
      if (!this.dirty) {
        this.stats.skippedIdleFrames++;
        return;
      }
      this.dirty = false;
      const frameAt = Date.now();
      if (this.lastFrameAt > 0) {
        this.totalFrameInterval += frameAt - this.lastFrameAt;
        this.frameIntervalSamples++;
        this.stats.averageActiveFrameIntervalMs = this.totalFrameInterval / this.frameIntervalSamples;
      }
      this.lastFrameAt = frameAt;
      this.stats.renderedFrames++;
      this.flush();
    }, delay);
  }
}

function isPromptReason(reason: DirtyReason): boolean {
  return (
    reason === 'completion' || reason === 'error' || reason === 'approval' || reason === 'input' || reason === 'scroll'
  );
}
