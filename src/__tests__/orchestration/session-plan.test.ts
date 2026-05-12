import { Session } from '../../session/Session';
import { AgentRunnerOptions, AgentClient } from '../../session/types';

describe('Session orchestration planning', () => {

  const buildMockClient = (responseContent: string): AgentClient => ({
    chat: jest.fn().mockResolvedValue({
      content: responseContent,
      usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
    })
  });

  const getMinimalOptions = (client: AgentClient): AgentRunnerOptions => ({
      repoRoot: process.cwd(),
      client,
    });

  it('identifies tasks that should orchestrate', () => {
     const session = new Session(getMinimalOptions(buildMockClient('')));
     expect(session.shouldOrchestrate({
       estimatedTokens: 3000,
       strategy: 'orchestrated' as any,
       safetyMargin: 1000,
       utilization: 0.9,
       contextWindowTokens: 4000,
       breakdown: {
         taskTokens: 10, repoOverheadTokens: 0, systemOverheadTokens: 50
       }
     })).toBe(true);

     expect(session.shouldOrchestrate({
       estimatedTokens: 3000,
       strategy: 'inline',
       safetyMargin: 1000,
       utilization: 0.5,
       contextWindowTokens: 8000,
       breakdown: {
         taskTokens: 10, repoOverheadTokens: 0, systemOverheadTokens: 50
       }
     })).toBe(false);
  });

  it('generates an orchestration plan properly', async () => {
     const mockResponse = JSON.stringify({
       planId: "p1",
       subtasks: [{ id: "s1", description: "Hello", fileScope: [], dependencies: [], parallelizable: false, estimatedTokens: 1000 }]
     });
     
     const client = buildMockClient(mockResponse);
     const session = new Session(getMinimalOptions(client));
     
     // Spy on EventBus
     const eventSpy = jest.fn();
     session.eventBus.on('orchestration_plan_generated' as any, (e: any) => {
         eventSpy(e);
     });
     
     const result = await session.planOrchestratedTurn("do big work");
     expect(result.success).toBe(true);
     if (result.success) {
       expect(result.plan.planId).toBe("p1");
     }
     
     expect(client.chat).toHaveBeenCalledTimes(1);
     expect((client.chat as jest.Mock).mock.calls[0][0].messages[0].content).toContain("You are an expert system orchestrator");
     
     expect(eventSpy).toHaveBeenCalledTimes(1);
     expect(eventSpy.mock.calls[0][0].payload.plan.planId).toBe("p1");
  });
  
});
