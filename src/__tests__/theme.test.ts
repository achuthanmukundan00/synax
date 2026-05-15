import { getPalette, getPaletteNames, applyConfigOverrides } from '../tui/theme';

describe('theme system', () => {
  it('returns the default palette when no name given', () => {
    const pal = getPalette();
    expect(pal.name).toBe('default');
    expect(pal.semantic.plan).toBe('#bd93f9');
    expect(pal.semantic.error).toBe('#ff5555');
    expect(pal.semantic.command).toBe('#8be9fd');
  });

  it('returns the default palette for unknown names', () => {
    const pal = getPalette('nonexistent');
    expect(pal.name).toBe('default');
  });

  it('returns all palette presets', () => {
    const names = getPaletteNames();
    expect(names).toContain('default');
    expect(names).toContain('dark');
    expect(names).toContain('light');
    expect(names).toContain('high-contrast');
  });

  it('each palette has all semantic slots', () => {
    const slots = [
      'plan',
      'edit',
      'diff',
      'command',
      'tool_result',
      'review',
      'commit',
      'checkpoint',
      'approval',
      'status',
      'error',
      'note',
      'assistant_text',
    ];
    for (const name of getPaletteNames()) {
      const pal = getPalette(name);
      for (const slot of slots) {
        expect(pal.semantic[slot as keyof typeof pal.semantic]).toBeDefined();
      }
    }
  });

  it('dark palette differs from default', () => {
    const def = getPalette('default');
    const dark = getPalette('dark');
    expect(dark.background).not.toBe(def.background);
  });

  it('light palette has light background', () => {
    const light = getPalette('light');
    expect(light.background).toBe('#f8f8f8');
    expect(light.text).toBe('#1a1a1a');
  });

  it('high-contrast palette has white borders', () => {
    const hc = getPalette('high-contrast');
    expect(hc.border).toBe('#ffffff');
    expect(hc.background).toBe('#000000');
  });

  it('applyConfigOverrides overrides specific semantic slots', () => {
    const original = getPalette('default');
    const overridden = applyConfigOverrides(original, { plan: '#ff0000', edit: '#00ff00' });
    expect(overridden.semantic.plan).toBe('#ff0000');
    expect(overridden.semantic.edit).toBe('#00ff00');
    // Unchanged slots stay the same
    expect(overridden.semantic.command).toBe(original.semantic.command);
    expect(overridden.name).toBe(original.name);
  });

  it('applyConfigOverrides returns original palette when overrides is undefined', () => {
    const original = getPalette('default');
    const result = applyConfigOverrides(original, undefined);
    expect(result.semantic.plan).toBe(original.semantic.plan);
  });
});
