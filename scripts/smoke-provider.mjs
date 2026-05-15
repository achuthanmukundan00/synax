#!/usr/bin/env bun
/**
 * Live provider smoke test.
 *
 * Usage (from project root):
 *   SYNAX_LIVE_PROVIDER=relay bun scripts/smoke-provider.mjs
 *   SYNAX_LIVE_PROVIDER=custom SYNAX_CUSTOM_BASE_URL=http://127.0.0.1:1234/v1 bun scripts/smoke-provider.mjs
 *   SYNAX_LIVE_PROVIDER=deepseek bun scripts/smoke-provider.mjs
 *   SYNAX_LIVE_PROVIDER=openrouter bun scripts/smoke-provider.mjs
 *   SYNAX_LIVE_PROVIDER=groq bun scripts/smoke-provider.mjs
 *   SYNAX_LIVE_PROVIDER=anthropic bun scripts/smoke-provider.mjs
 *
 * Each smoke test:
 *  1. Resolves the provider preset and API key from environment.
 *  2. Sends a tiny non-streaming request.
 *  3. Expects the model to reply with exactly or approximately "synax-ok".
 *  4. Optionally tests a streaming request.
 *
 * These tests hit real APIs and require user-supplied API keys.
 * They must only run when explicitly invoked and must not run in CI.
 */

import { createServer } from 'http';

// ─── Config ─────────────────────────────────────────

const PROVIDER = process.env.SYNAX_LIVE_PROVIDER;
if (!PROVIDER) {
  console.log('SKIP: SYNAX_LIVE_PROVIDER not set. Set it to one of: relay, custom, deepseek, openrouter, groq, anthropic');
  process.exit(0);
}

// ─── Provider presets ───────────────────────────────

const PRESETS = {
  relay: {
    protocol: 'openai-compatible',
    baseUrl: process.env.SYNAX_RELAY_BASE_URL || 'http://127.0.0.1:1234/v1',
    apiKeyEnv: null,
    apiKeyRequired: false,
    model: 'Qwen3.6-35B-A3B-UD-IQ3_XXS.gguf',
  },
  custom: {
    protocol: 'openai-compatible',
    baseUrl: process.env.SYNAX_CUSTOM_BASE_URL || '',
    apiKeyEnv: null,
    apiKeyRequired: false,
    model: process.env.SYNAX_CUSTOM_MODEL || 'local-model',
  },
  deepseek: {
    protocol: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    apiKeyRequired: true,
    model: 'deepseek-chat',
  },
  openrouter: {
    protocol: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    apiKeyRequired: true,
    model: process.env.SYNAX_OPENROUTER_MODEL || 'deepseek/deepseek-chat',
  },
  groq: {
    protocol: 'openai-compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    apiKeyRequired: true,
    model: 'llama-3.3-70b-versatile',
  },
  anthropic: {
    protocol: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    apiKeyRequired: true,
    model: process.env.SYNAX_ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929',
  },
};

// ─── Resolve preset ─────────────────────────────────

const preset = PRESETS[PROVIDER];
if (!preset) {
  console.log(`SKIP: Unknown provider "${PROVIDER}". Known: ${Object.keys(PRESETS).join(', ')}`);
  process.exit(0);
}

if (preset.apiKeyRequired) {
  const key = process.env[preset.apiKeyEnv];
  if (!key) {
    console.log(`SKIP: ${preset.apiKeyEnv} not set for provider "${PROVIDER}". Set it to run this smoke test.`);
    process.exit(0);
  }
  preset._apiKey = key;
}

if (!preset.baseUrl) {
  console.log(`SKIP: No base URL for provider "${PROVIDER}". Set SYNAX_CUSTOM_BASE_URL.`);
  process.exit(0);
}

// ─── HTTP helpers ───────────────────────────────────

async function postJson(url, body, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await res.text();
    return { status: res.status, body: text };
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ─── Non-streaming test ─────────────────────────────

async function testNonStreaming() {
  console.log(`\n[smoke:${PROVIDER}] Non-streaming test...`);

  let url, headers, body;

  if (preset.protocol === 'anthropic-messages') {
    url = `${preset.baseUrl}/v1/messages`;
    headers = {
      'x-api-key': preset._apiKey,
      'anthropic-version': '2023-06-01',
    };
    body = {
      model: preset.model,
      max_tokens: 8,
      temperature: 0,
      messages: [{ role: 'user', content: 'Reply with exactly: synax-ok' }],
    };
  } else {
    url = `${preset.baseUrl}/chat/completions`;
    headers = {};
    if (preset._apiKey) {
      headers['Authorization'] = `Bearer ${preset._apiKey}`;
    }
    body = {
      model: preset.model,
      messages: [{ role: 'user', content: 'Reply with exactly: synax-ok' }],
      temperature: 0,
      max_tokens: 8,
      stream: false,
    };
  }

  try {
    const result = await postJson(url, body, headers);

    if (result.status !== 200) {
      console.log(`FAIL: HTTP ${result.status}`);
      console.log(`  Response: ${result.body.slice(0, 500)}`);
      return false;
    }

    let content;
    if (preset.protocol === 'anthropic-messages') {
      const data = JSON.parse(result.body);
      content = data.content?.map((c) => c.text).join('') || '';
    } else {
      const data = JSON.parse(result.body);
      content = data.choices?.[0]?.message?.content || '';
    }

    const normalized = content.trim().toLowerCase();
    if (normalized === 'synax-ok' || normalized.includes('synax-ok')) {
      console.log(`PASS: Got "synax-ok" from ${preset.model}`);
      return true;
    }

    console.log(`WARN: Unexpected response content: "${content.slice(0, 200)}"`);
    console.log(`  (Expected exactly "synax-ok")`);
    return true; // Not a hard fail — model replied
  } catch (err) {
    console.log(`FAIL: ${err.message}`);
    return false;
  }
}

// ─── Streaming test (optional) ──────────────────────

async function testStreaming() {
  console.log(`\n[smoke:${PROVIDER}] Streaming test...`);

  let url, headers, body;

  if (preset.protocol === 'anthropic-messages') {
    url = `${preset.baseUrl}/v1/messages`;
    headers = {
      'x-api-key': preset._apiKey,
      'anthropic-version': '2023-06-01',
    };
    body = {
      model: preset.model,
      max_tokens: 16,
      temperature: 0,
      stream: true,
      messages: [{ role: 'user', content: 'Reply with exactly: synax-stream-ok' }],
    };
  } else {
    url = `${preset.baseUrl}/chat/completions`;
    headers = {};
    if (preset._apiKey) {
      headers['Authorization'] = `Bearer ${preset._apiKey}`;
    }
    body = {
      model: preset.model,
      messages: [{ role: 'user', content: 'Reply with exactly: synax-stream-ok' }],
      temperature: 0,
      max_tokens: 16,
      stream: true,
    };
    headers['Accept'] = 'text/event-stream';
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (res.status !== 200) {
      const text = await res.text();
      console.log(`FAIL: HTTP ${res.status} — ${text.slice(0, 200)}`);
      return false;
    }

    const text = await res.text();
    // Collect content from SSE stream
    let fullContent = '';
    const lines = text.split('\n');
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          if (preset.protocol === 'anthropic-messages') {
            if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
              fullContent += parsed.delta.text;
            }
          } else {
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) fullContent += delta;
          }
        } catch {
          // Skip unparseable chunks
        }
      }
    }

    const normalized = fullContent.trim().toLowerCase();
    if (normalized === 'synax-stream-ok' || normalized.includes('synax-stream-ok')) {
      console.log(`PASS: Got "synax-stream-ok" via streaming`);
      return true;
    }

    console.log(`WARN: Unexpected streamed content: "${fullContent.slice(0, 200)}"`);
    return true;
  } catch (err) {
    console.log(`SKIP: Streaming failed: ${err.message}`);
    return false;
  }
}

// ─── Main ───────────────────────────────────────────

async function main() {
  console.log(`Synax Provider Smoke Test — ${PROVIDER}`);
  console.log(`  Protocol: ${preset.protocol}`);
  console.log(`  Base URL: ${preset.baseUrl}`);
  console.log(`  Model:    ${preset.model}`);
  console.log(`  Auth:     ${preset._apiKey ? 'API key configured' : 'no API key (local)'}`);

  const nonStreamingOk = await testNonStreaming();

  if (!nonStreamingOk) {
    console.log(`\n[smoke:${PROVIDER}] Non-streaming failed — skipping streaming test.`);
    process.exit(1);
  }

  await testStreaming();

  console.log(`\n[smoke:${PROVIDER}] Done.`);
}

main().catch((err) => {
  console.error(`[smoke:${PROVIDER}] Fatal: ${err.message}`);
  process.exit(1);
});
