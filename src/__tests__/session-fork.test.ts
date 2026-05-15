import { Session } from '../session/Session';
import type { SubTask } from '../session/types';
import type { HandoffManifest } from '../handoff/types';
import type { ChildSessionSpawnedEvent, ChildSessionCompletedEvent } from '../events/types';

function mockClient(success: boolean = true) {
  return {
    chat: async (): Promise<any> => ({
      content: success ? 'Task completed.' : '',
      model: 'test-model',
      finishReason: 'stop',
      toolCalls: success ? [] : [{ id: 'tc-1', type: 'function', function: { name: 'bash', arguments: '{}' } }],
      toolCallFormat: 'openai',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      reasoningContent: '',
    }),
  };
}

describe('Session.fork()', () => {
  it('should spawn a child session and emit lifecycle events', async () => {
    let childSpawned: ChildSessionSpawnedEvent | undefined;
    let childCompleted: ChildSessionCompletedEvent | undefined;
    let childModelStepStarted = false;

    const parentSession = new Session({
      repoRoot: '/tmp/test',
      client: mockClient(true),
      sessionId: 'parent-123',
    });

    parentSession.onEvent = (event: any) => {
      if (event.type === 'child_session_spawned') {
        childSpawned = event;
      }
      if (event.type === 'child_session_completed') {
        childCompleted = event;
      }
      if (event.type === 'model_step_started') {
        childModelStepStarted = true;
      }
    };

    const subtask: SubTask = {
      id: 'sub-1',
      description: 'Fix the UI bug',
      estimatedBudget: 500,
      fileScope: ['src/ui/button.tsx'],
      dependencies: [],
      verification: { level: 'none', label: 'no verification' },
    };

    const manifest: HandoffManifest = {
      handoffId: 'test-1',
      parentSessionId: 'parent-123',
      reason: 'task_delegation',
      task: 'Fix bugs',
      status: 'starting',
      keyFindings: [],
      filesChanged: [],
      filesRead: [],
      pendingWork: [],
      suggestedSearchTerms: [],
      contextWindowUsed: 0,
      depth: 0,
      createdAt: new Date().toISOString(),
    };

    const result = await parentSession.fork(subtask, manifest);

    expect(result.subTaskId).toBe('sub-1');
    expect(result.terminalState).toBe('completed');

    expect(childSpawned).toBeDefined();
    expect(childSpawned?.parentSessionId).toBe('parent-123');
    expect(childSpawned?.subtaskId).toBe('sub-1');

    expect(childCompleted).toBeDefined();
    expect(childCompleted?.parentSessionId).toBe('parent-123');
    expect(childCompleted?.subtaskId).toBe('sub-1');
    expect(childCompleted?.result.terminalState).toBe('completed');
    expect(childModelStepStarted).toBe(true);
  });
});
