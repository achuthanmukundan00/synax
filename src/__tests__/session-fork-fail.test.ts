import { Session } from '../session/Session';
import type { SubTask } from '../session/types';
import type { HandoffManifest } from '../handoff/types';
import type { ChildSessionFailedEvent } from '../events/types';

function mockClient(success: boolean = true) {
  return {
    chat: async (): Promise<any> => {
      if (!success) {
        throw new Error('Simulated model error');
      }
      return {
        content: 'Task completed.',
        model: 'test-model',
        finishReason: 'stop',
        toolCalls: [],
        toolCallFormat: 'openai',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        reasoningContent: '',
      };
    },
  };
}

describe('Session.fork() failure', () => {
  it('should emit child_session_failed when child drops out', async () => {
    let childFailed: ChildSessionFailedEvent | undefined;

    const parentSession = new Session({
      repoRoot: '/tmp/test',
      // We force an immediate model error
      client: mockClient(false),
      sessionId: 'parent-123',
    });

    parentSession.onEvent = (event: any) => {
      if (event.type === 'child_session_failed') {
        childFailed = event;
      }
    };

    const subtask: SubTask = {
      id: 'sub-fail',
      description: 'Break things',
      estimatedBudget: 50,
      fileScope: [],
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

    expect(result.subTaskId).toBe('sub-fail');
    expect(result.terminalState).toBe('model_error');

    expect(childFailed).toBeDefined();
    expect(childFailed?.parentSessionId).toBe('parent-123');
    expect(childFailed?.subtaskId).toBe('sub-fail');
    expect(childFailed?.error).toBeDefined();
    expect(childFailed?.partialResult.terminalState).toBe('model_error');
  });
});
