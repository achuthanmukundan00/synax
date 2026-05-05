import { Command } from 'commander';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { loadProjectConfig, normalizeProviderConfig } from '../config/project';
import { createOpenAICompatibleClient } from '../llm/client';
import type { NormalizedProviderConfig } from '../llm/types';
import { PROJECT_CONTEXT_PATH, type ProjectContextFile } from './inspect';

const NO_CONTEXT_MESSAGE = 'NO_CONTEXT: run `synax inspect` first or enable project context.';

function redactSensitive(value: string, cfg: NormalizedProviderConfig): string {
  let redacted = value;
  const secrets = [cfg.apiKey, ...Object.values(cfg.customHeaders ?? {})].filter(
    (secret): secret is string => typeof secret === 'string' && secret.length > 0,
  );
  for (const secret of secrets) {
    redacted = redacted.split(secret).join('[redacted]');
  }
  return redacted;
}

function formatProviderError(err: unknown, cfg: NormalizedProviderConfig): string {
  const error = err as Error & { type?: string; statusCode?: number; detail?: string; retryable?: boolean };
  const lines = ['[synax] Provider request failed.'];
  if (error.type) lines.push(`Type: ${redactSensitive(error.type, cfg)}`);
  if (error.statusCode) lines.push(`Status: ${error.statusCode}`);
  const detail = error.detail ?? error.message;
  if (detail) lines.push(`Detail: ${redactSensitive(detail, cfg)}`);
  return lines.join('\n');
}

function asksForProjectContext(question: string): boolean {
  const normalized = question.toLowerCase();
  const currentProjectPattern = /\b(this|current|the|my|our)\s+(project|repo|repository|codebase|workspace)\b/;
  const repoSubjectPattern = /\b(project|repo|repository|codebase|workspace)\b/;
  const repoObjectPattern =
    /\b(files?|config|configuration|tests?|test suite|commands?|scripts?|package\.json|tsconfig|readme)\b/;
  const inspectionPattern =
    /\b(inspect|summari[sz]e|explain|trace|analy[sz]e)\b.*\b(project|repo|repository|codebase|workspace|files?)\b/;
  const validationPattern = /\b(validation|verify|verification|test|build)\s+commands?\b/;

  return (
    currentProjectPattern.test(normalized) ||
    inspectionPattern.test(normalized) ||
    validationPattern.test(normalized) ||
    (repoSubjectPattern.test(normalized) && repoObjectPattern.test(normalized))
  );
}

function loadProjectContext(baseDir = process.cwd()): ProjectContextFile | null {
  const contextPath = join(baseDir, PROJECT_CONTEXT_PATH);
  if (!existsSync(contextPath)) return null;

  try {
    const parsed = JSON.parse(readFileSync(contextPath, 'utf-8')) as Partial<ProjectContextFile>;
    if (parsed.version !== 1 || parsed.kind !== 'inspect-profile' || typeof parsed.profileText !== 'string') {
      return null;
    }
    return parsed as ProjectContextFile;
  } catch {
    return null;
  }
}

export async function handleAskCommand(options: { question?: string }): Promise<void> {
  if (!options.question) {
    console.log('[synax] Ask command initialized. Use --question to provide a question.');
    return;
  }

  const projectContext = loadProjectContext();
  const needsProjectContext = asksForProjectContext(options.question);
  if (needsProjectContext && !projectContext) {
    console.log(NO_CONTEXT_MESSAGE);
    return;
  }

  const result = loadProjectConfig();
  if (result.errors.length > 0) {
    const messages = result.errors.map((e) => `${e.path}: ${e.message}`).join('\n');
    console.error(`[synax] Config error:\n${messages}`);
    process.exitCode = 1;
    return;
  }

  const normalized = normalizeProviderConfig(result.config.provider ?? {});
  if (!normalized.model.trim()) {
    console.error('[synax] Config error: provider.model is required for ask.');
    process.exitCode = 1;
    return;
  }

  try {
    const client = createOpenAICompatibleClient(normalized);
    const messages = needsProjectContext
      ? [
          {
            role: 'system' as const,
            content: [
              'Answer using only this safe Synax inspect project profile for repository-specific details.',
              'If the profile does not contain the requested detail, say it is not available in the inspect profile.',
              '',
              projectContext!.profileText,
            ].join('\n'),
          },
          { role: 'user' as const, content: options.question },
        ]
      : [{ role: 'user' as const, content: options.question }];
    const response = await client.chat({
      messages,
      temperature: 0,
      maxTokens: 1024,
    });
    console.log(response.content.trim());
  } catch (err) {
    console.error(formatProviderError(err, normalized));
    process.exitCode = 1;
  }
}

export function askCommand(program: Command): void {
  const ask = new Command('ask');
  ask
    .description('Ask a question without executing any actions')
    .option('-q, --question <question>', 'Question to ask')
    .action(async (options: { question?: string }) => {
      await handleAskCommand(options);
    });
  program.addCommand(ask);
}
