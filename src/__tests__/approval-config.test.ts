import {
  readApprovalConfig,
  isCommandAutoApproved,
  formatApprovalPolicy,
  clearApprovalRules,
} from '../tui/approval-config';

describe('approval config', () => {
  it('returns empty patterns when no config file exists', () => {
    const config = readApprovalConfig('/tmp/nonexistent-path');
    expect(config.patterns).toEqual([]);
  });

  it('formatApprovalPolicy shows "ask all" when no rules', () => {
    const policy = formatApprovalPolicy({ patterns: [] });
    expect(policy).toContain('ask all');
  });

  it('formatApprovalPolicy shows count when rules exist', () => {
    const policy = formatApprovalPolicy({ patterns: ['npm test*'] });
    expect(policy).toContain('auto');
    expect(policy).toContain('1 rule');
  });

  it('formatApprovalPolicy pluralizes rules', () => {
    const policy = formatApprovalPolicy({ patterns: ['npm test*', 'git commit*'] });
    expect(policy).toContain('2 rules');
  });

  it('isCommandAutoApproved returns false for empty config', () => {
    expect(isCommandAutoApproved('npm test', { patterns: [] })).toBe(false);
  });

  it('isCommandAutoApproved matches wildcard patterns', () => {
    const config = { patterns: ['npm test*'] };
    expect(isCommandAutoApproved('npm test -- src/auth.test.ts', config)).toBe(true);
    expect(isCommandAutoApproved('pnpm build', config)).toBe(false);
  });

  it('isCommandAutoApproved matches exact patterns', () => {
    const config = { patterns: ['git status'] };
    expect(isCommandAutoApproved('git status', config)).toBe(true);
    expect(isCommandAutoApproved('git status --short', config)).toBe(false);
  });

  it('clearApprovalRules returns 0 for non-existent file', () => {
    const count = clearApprovalRules('/tmp/nonexistent-path');
    expect(count).toBe(0);
  });
});
