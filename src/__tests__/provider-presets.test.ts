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
      expect(preset!.protocol).toBe('openai-compatible');
      expect(preset!.baseUrl).toBe('http://127.0.0.1:1234/v1');
      expect(preset!.apiKeyRequired).toBe(false);
      expect(preset!.cloud).toBe(false);
    });

    it('returns custom preset', () => {
      const preset = getProviderPreset('custom');
      expect(preset).toBeDefined();
      expect(preset!.protocol).toBe('openai-compatible');
      expect(preset!.apiKeyRequired).toBe(false);
      expect(preset!.cloud).toBe(false);
    });

    it('returns deepseek preset with correct base URL', () => {
      const preset = getProviderPreset('deepseek');
      expect(preset).toBeDefined();
      expect(preset!.protocol).toBe('openai-compatible');
      expect(preset!.baseUrl).toBe('https://api.deepseek.com/v1');
      expect(preset!.apiKeyEnv).toBe('DEEPSEEK_API_KEY');
      expect(preset!.apiKeyRequired).toBe(true);
      expect(preset!.cloud).toBe(true);
      expect(preset!.defaultModel).toBe('deepseek-chat');
      expect(preset!.contextWindow).toBe(1_000_000);
    });

    it('returns openrouter preset with default headers', () => {
      const preset = getProviderPreset('openrouter');
      expect(preset).toBeDefined();
      expect(preset!.protocol).toBe('openai-compatible');
      expect(preset!.baseUrl).toBe('https://openrouter.ai/api/v1');
      expect(preset!.apiKeyEnv).toBe('OPENROUTER_API_KEY');
      expect(preset!.apiKeyRequired).toBe(true);
      expect(preset!.cloud).toBe(true);
      expect(preset!.defaultHeaders).toEqual({
        'HTTP-Referer': 'https://github.com/achuthanmukundan00/synax',
        'X-Title': 'Synax',
      });
    });

    it('returns groq preset with correct base URL', () => {
      const preset = getProviderPreset('groq');
      expect(preset).toBeDefined();
      expect(preset!.protocol).toBe('openai-compatible');
      expect(preset!.baseUrl).toBe('https://api.groq.com/openai/v1');
      expect(preset!.apiKeyEnv).toBe('GROQ_API_KEY');
      expect(preset!.apiKeyRequired).toBe(true);
      expect(preset!.cloud).toBe(true);
      expect(preset!.defaultModel).toBe('llama-3.3-70b-versatile');
      expect(preset!.contextWindow).toBe(128000);
    });

    it('returns anthropic preset with correct protocol', () => {
      const preset = getProviderPreset('anthropic');
      expect(preset).toBeDefined();
      expect(preset!.protocol).toBe('anthropic-messages');
      expect(preset!.baseUrl).toBe('https://api.anthropic.com');
      expect(preset!.apiKeyEnv).toBe('ANTHROPIC_API_KEY');
      expect(preset!.apiKeyRequired).toBe(true);
      expect(preset!.cloud).toBe(true);
      expect(preset!.defaultModel).toBe('claude-sonnet-4-5-20250929');
      expect(preset!.contextWindow).toBe(200000);
      expect(preset!.supportsToolCalling).toBe(false); // not implemented yet
    });

    it('returns mistral preset', () => {
      const preset = getProviderPreset('mistral');
      expect(preset).toBeDefined();
      expect(preset!.protocol).toBe('openai-compatible');
      expect(preset!.baseUrl).toBe('https://api.mistral.ai/v1');
      expect(preset!.apiKeyEnv).toBe('MISTRAL_API_KEY');
    });

    it('returns together preset', () => {
      const preset = getProviderPreset('together');
      expect(preset).toBeDefined();
      expect(preset!.protocol).toBe('openai-compatible');
      expect(preset!.baseUrl).toBe('https://api.together.xyz/v1');
      expect(preset!.apiKeyEnv).toBe('TOGETHER_API_KEY');
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
    it('returns all 8 presets', () => {
      const all = getAllProviderPresets();
      expect(all).toHaveLength(8);
      const ids = all.map((p) => p.id);
      expect(ids).toContain('relay');
      expect(ids).toContain('custom');
      expect(ids).toContain('deepseek');
      expect(ids).toContain('openrouter');
      expect(ids).toContain('groq');
      expect(ids).toContain('anthropic');
      expect(ids).toContain('mistral');
      expect(ids).toContain('together');
    });
  });
});
