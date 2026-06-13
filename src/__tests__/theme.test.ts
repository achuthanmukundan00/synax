import { getPalette, getPaletteNames, applyConfigOverrides } from '../tui/theme';

describe('theme system', () => {
  it('returns the mono palette when no name given', () => {
    const pal = getPalette();
    expect(pal.name).toBe('mono');
    expect(pal.semantic.plan).toBe('#888888');
    expect(pal.semantic.error).toBe('#cc6666');
    expect(pal.semantic.command).toBe('#5f8fc7');
  });

  it('returns the mono palette for unknown names', () => {
    const pal = getPalette('nonexistent');
    expect(pal.name).toBe('mono');
  });

  it('returns all palette presets', () => {
    const names = getPaletteNames();
    expect(names).toContain('mono');
    expect(names).toContain('gruvbox');
    expect(names).toContain('kanagawa');
    expect(names).toContain('catppuccin');
    expect(names).toContain('nord');
    expect(names).toContain('rose-pine');
    expect(names).toContain('tokyo-night');
    expect(names).toContain('pink');
    expect(names).toContain('dracula');
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
      'dispatch',
      'agent_status',
      'thinking',
    ];
    for (const name of getPaletteNames()) {
      const pal = getPalette(name);
      for (const slot of slots) {
        expect(pal.semantic[slot as keyof typeof pal.semantic]).toBeDefined();
      }
    }
  });

  it('default name resolves to mono palette', () => {
    const def = getPalette('default');
    const mono = getPalette('mono');
    expect(def.name).toBe('mono');
    expect(def.background).toBe(mono.background);
  });

  it('dracula palette has dark background', () => {
    const dracula = getPalette('dracula');
    expect(dracula.background).toBe('#14111a');
    expect(dracula.semantic.error).toBe('#ff5555');
    expect(dracula.semantic.command).toBe('#8be9fd');
  });

  it('catppuccin palette has distinct semantic colors', () => {
    const cat = getPalette('catppuccin');
    expect(cat.background).toBe('#1e1e2e');
    expect(cat.semantic.plan).toBe('#cba6f7');
    expect(cat.semantic.tool_result).toBe('#a6e3a1');
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
