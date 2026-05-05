import { Command } from 'commander';
import { loadProjectConfig, normalizeProviderConfig } from '../config/project';
import { createOpenAICompatibleClient } from '../llm/client';
import type { NormalizedProviderConfig } from '../llm/types';

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

export async function handleAskCommand(options: { question?: string }): Promise<void> {
  if (!options.question) {
    console.log('[synax] Ask command initialized. Use --question to provide a question.');
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
    const response = await client.chat({
      messages: [{ role: 'user', content: options.question }],
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
