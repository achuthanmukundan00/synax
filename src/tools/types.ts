import { InspectionLedger } from './ledger';
import { ContextLedger } from './context-ledger';
import { GeneratedContentStore } from './generated-content';

export type LedgerBehavior =
  | 'none'
  | 'records-file-list'
  | 'records-file-range'
  | 'records-search-results'
  | 'records-git-status'
  | 'records-git-diff'
  | 'records-pasted-range';

export interface ToolSafetyPolicy {
  readOnly: boolean;
  rejectsUnsafePaths: boolean;
  boundedOutput: boolean;
}

export interface ToolContext {
  repoRoot: string;
  ledger: InspectionLedger;
  generatedContent?: GeneratedContentStore;
}

export interface AgentContext {
  repoRoot: string;
  inspectionLedger: InspectionLedger;
  contextLedger: ContextLedger;
}

export interface ToolResult<TOutput = unknown> {
  success: boolean;
  toolName: string;
  output?: TOutput;
  error?: string;
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  safetyPolicy: ToolSafetyPolicy;
  ledgerBehavior: LedgerBehavior;
  execute(input: TInput, context: ToolContext): Promise<ToolResult<TOutput>>;
}

export interface ToolRegistry {
  list(): ToolDefinition[];
  get(name: string): ToolDefinition | undefined;
  execute(name: string, input: unknown): Promise<ToolResult>;
  register(definition: ToolDefinition): void;
}
