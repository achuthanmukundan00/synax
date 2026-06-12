/**
 * Tests for provider presets registry.
 * Covers: preset lookup, known provider IDs, preset properties.
 */

import { getAllProviderPresets, getProviderPreset, isKnownProviderId } from '../llm/provider-presets';

describe('Provider presets registry', () => {
  describe('getProviderPreset', () => {
    it('returns relay preset', () => {
      const preset = getProviderPreset('relay');
      expect(preset).toBeDefined();
      const p = preset as NonNullable<typeof preset>;
      expect(p.protocol).toBe('openai-compatible');
      expect(p.baseUrl).toBe('http://127.0.0.1:1234/v1');
      expect(p.apiKeyRequired).toBe(false);
      expect(p.cloud).toBe(false);
    });

    it('returns custom preset', () => {
      const preset = getProviderPreset('custom');
      expect(preset).toBeDefined();
      const p = preset as NonNullable<typeof preset>;
      expect(p.protocol).toBe('openai-compatible');
      expect(p.apiKeyRequired).toBe(false);
      expect(p.cloud).toBe(false);
    });

    it('returns deepseek preset with correct base URL', () => {
      const preset = getProviderPreset('deepseek');
      expect(preset).toBeDefined();
      const p = preset as NonNullable<typeof preset>;
      expect(p.protocol).toBe('openai-compatible');
      expect(p.baseUrl).toBe('https://api.deepseek.com/v1');
      expect(p.apiKeyEnv).toBe('DEEPSEEK_API_KEY');
      expect(p.apiKeyRequired).toBe(true);
      expect(p.cloud).toBe(true);
      expect(p.defaultModel).toBe('deepseek-v4-pro');
      expect(p.contextWindow).toBe(128_000);
    });

    it('returns openrouter preset with default headers', () => {
      const preset = getProviderPreset('openrouter');
      expect(preset).toBeDefined();
      const p = preset as NonNullable<typeof preset>;
      expect(p.protocol).toBe('openai-compatible');
      expect(p.baseUrl).toBe('https://openrouter.ai/api/v1');
      expect(p.apiKeyEnv).toBe('OPENROUTER_API_KEY');
      expect(p.apiKeyRequired).toBe(true);
      expect(p.cloud).toBe(true);
      expect(p.defaultHeaders).toEqual({
        'HTTP-Referer': 'https://github.com/achuthanmukundan00/synax',
        'X-Title': 'Synax',
      });
    });

    it('returns groq preset with correct base URL', () => {
      const preset = getProviderPreset('groq');
      expect(preset).toBeDefined();
      const p = preset as NonNullable<typeof preset>;
      expect(p.protocol).toBe('openai-compatible');
      expect(p.baseUrl).toBe('https://api.groq.com/openai/v1');
      expect(p.apiKeyEnv).toBe('GROQ_API_KEY');
      expect(p.apiKeyRequired).toBe(true);
      expect(p.cloud).toBe(true);
      expect(p.defaultModel).toBe('llama-3.3-70b-versatile');
      expect(p.contextWindow).toBe(128000);
    });

    it('returns anthropic preset with correct protocol', () => {
      const preset = getProviderPreset('anthropic');
      expect(preset).toBeDefined();
      const p = preset as NonNullable<typeof preset>;
      expect(p.protocol).toBe('anthropic-messages');
      expect(p.baseUrl).toBe('https://api.anthropic.com');
      expect(p.apiKeyEnv).toBe('ANTHROPIC_API_KEY');
      expect(p.apiKeyRequired).toBe(true);
      expect(p.cloud).toBe(true);
      expect(p.defaultModel).toBe('frontier-sonnet-4-5-20250929');
      expect(p.contextWindow).toBe(200000);
      expect(p.supportsToolCalling).toBe(false); // not implemented yet
    });

    it('returns mistral preset', () => {
      const preset = getProviderPreset('mistral');
      expect(preset).toBeDefined();
      const p = preset as NonNullable<typeof preset>;
      expect(p.protocol).toBe('openai-compatible');
      expect(p.baseUrl).toBe('https://api.mistral.ai/v1');
      expect(p.apiKeyEnv).toBe('MISTRAL_API_KEY');
    });

    it('returns together preset', () => {
      const preset = getProviderPreset('together');
      expect(preset).toBeDefined();
      const p = preset as NonNullable<typeof preset>;
      expect(p.protocol).toBe('openai-compatible');
      expect(p.baseUrl).toBe('https://api.together.xyz/v1');
      expect(p.apiKeyEnv).toBe('TOGETHER_API_KEY');
    });

    it('returns undefined for unknown provider', () => {
      expect(getProviderPreset('gemini')).toBeUndefined();
      expect(getProviderPreset('nonexistent')).toBeUndefined();
    });
  });

  describe('isKnownProviderId', () => {
    it.each(['relay', 'custom', 'deepseek', 'openrouter', 'groq', 'anthropic', 'mistral', 'together'])(
      'recognizes %s',
      (id) => {
        expect(isKnownProviderId(id)).toBe(true);
      },
    );

    it.each(['gemini', 'vertex', 'bedrock', 'azure', ''])('rejects %s', (id) => {
      expect(isKnownProviderId(id)).toBe(false);
    });
  });

  describe('getAllProviderPresets', () => {
    it('returns all 9 presets', () => {
      const all = getAllProviderPresets();
      expect(all).toHaveLength(9);
      const ids = all.map((p) => p.id);
      expect(ids).toContain('relay');
      expect(ids).toContain('custom');
      expect(ids).toContain('openai');
      expect(ids).toContain('deepseek');
      expect(ids).toContain('openrouter');
      expect(ids).toContain('groq');
      expect(ids).toContain('anthropic');
      expect(ids).toContain('mistral');
      expect(ids).toContain('together');
    });
  });
});
