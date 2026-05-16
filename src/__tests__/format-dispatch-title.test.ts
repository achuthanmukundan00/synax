/**
 * Tests for TUI formatting helpers.
 *
 * Covers formatDispatchTitle guards:
 * - 0 agents / inline mode → "Inline · no delegation"
 * - 1 agent in parallel mode → "Delegated · 1 agent"
 * - 1 agent in any mode → "Delegated · 1 agent"
 * - repo_reconnaissance strategy → "Strategy · repo reconnaissance (N domains)"
 * - 2+ agents parallel → "Dispatch · N agents · parallel"
 * - sequential mode → "Sequential plan · N steps"
 * - fallback → "Dispatch · N agents"
 */

import { formatDispatchTitle } from '../tui/semantic-events';

describe('formatDispatchTitle', () => {
  it('returns "Inline · no delegation" for 0 agents', () => {
    expect(formatDispatchTitle('parallel', 0, 'orchestrate')).toBe('Inline · no delegation');
  });

  it('returns "Inline · no delegation" for inline mode', () => {
    expect(formatDispatchTitle('inline', 1, 'inline')).toBe('Inline · no delegation');
  });

  it('returns "Inline · no delegation" for inline mode with 0 agents', () => {
    expect(formatDispatchTitle('inline', 0, 'inline')).toBe('Inline · no delegation');
  });

  it('returns "Delegated · 1 agent" for 1 agent in parallel mode', () => {
    expect(formatDispatchTitle('parallel', 1, 'orchestrate')).toBe('Delegated · 1 agent');
  });

  it('returns "Delegated · 1 agent" for 1 agent in any mode', () => {
    expect(formatDispatchTitle('sequential', 1, 'orchestrate')).toBe('Delegated · 1 agent');
  });

  it('returns "Delegated · 1 agent" for 1 agent with no mode', () => {
    expect(formatDispatchTitle('', 1, 'orchestrate')).toBe('Delegated · 1 agent');
  });

  it('returns repo reconnaissance label', () => {
    expect(formatDispatchTitle('parallel', 4, 'repo_reconnaissance')).toBe('Strategy · repo reconnaissance (4 domains)');
  });

  it('returns repo reconnaissance label for repo_recon strategy prefix', () => {
    expect(formatDispatchTitle('parallel', 3, 'repo_recon')).toBe('Strategy · repo reconnaissance (3 domains)');
  });

  it('returns parallel dispatch label', () => {
    expect(formatDispatchTitle('parallel', 3, 'orchestrate')).toBe('Dispatch · 3 agents · parallel');
  });

  it('returns sequential plan label', () => {
    expect(formatDispatchTitle('sequential', 5, 'orchestrate')).toBe('Sequential plan · 5 steps');
  });

  it('returns fallback label for unknown mode', () => {
    expect(formatDispatchTitle('delegated', 2, 'custom_strategy')).toBe('Dispatch · 2 agents');
  });

  it('returns fallback for delegated mode', () => {
    expect(formatDispatchTitle('delegated', 2, 'orchestrate')).toBe('Dispatch · 2 agents');
  });
});
