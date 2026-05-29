export type SuperRunKind = 'message' | 'pulse' | 'dream';

export type SuperSelfModificationMode = 'propose_only' | 'auto_apply_explicit';

export type SuperActionPlan = {
  summary: string;
  actions: Array<{
    id: string;
    title: string;
    rationale?: string;
    requiresUserConsent?: boolean;
  }>;
};

export type SuperRunRequest = {
  kind: SuperRunKind;
  input?: string;
  conversationId?: string;
  source?: string;
  sessionId?: string;
  now?: Date;
};

export type SuperRunResult = {
  status: 'completed' | 'skipped' | 'failed';
  response?: string;
  actionPlan?: SuperActionPlan;
  artifacts?: string[];
  error?: string;
};

export type SuperPatchSuggestion = {
  target: 'self.md' | 'world.md' | 'pulse.md';
  title: string;
  rationale: string;
  patch: string;
  createdAt: string;
  source: 'dream' | 'pulse' | 'message';
  mode: SuperSelfModificationMode;
};

export interface SynaxRuntimeLike {
  run(input: { input: string; context?: string; sessionId?: string }): Promise<{
    status: string;
    output: string;
    error?: string;
  }>;
}
