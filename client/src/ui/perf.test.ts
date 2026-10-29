import { describe, expect, it } from 'vitest';
import { AUTO_FPS, AUTO_SECONDS, AutoGovernor, levelOf } from './perf';
import { DEFAULT_PREFS, sanitizePrefs } from './prefs';

describe('levelOf', () => {
  it('o automático segue o nível decidido e os outros modos valem direto', () => {
    expect(levelOf('auto', 'light')).toBe('light');
    expect(levelOf('normal', 'light')).toBe('normal');
    expect(levelOf('min', 'normal')).toBe('min');
  });
});

describe('AutoGovernor', () => {
  it('liga o leve depois de AUTO_SECONDS segundos seguidos lentos', () => {
    const g = new AutoGovernor();
    for (let i = 0; i < AUTO_SECONDS - 1; i++) expect(g.sample(AUTO_FPS - 5, 'normal')).toBe(false);
    expect(g.sample(AUTO_FPS - 5, 'normal')).toBe(true);
  });
  it('um segundo bom zera a conta', () => {
    const g = new AutoGovernor();
    for (let i = 0; i < AUTO_SECONDS - 1; i++) g.sample(10, 'normal');
    g.sample(60, 'normal');
    for (let i = 0; i < AUTO_SECONDS - 1; i++) expect(g.sample(10, 'normal')).toBe(false);
  });
  it('sem medida (aba oculta, escritório parado) ou fora do normal, nunca liga', () => {
    const g = new AutoGovernor();
    for (let i = 0; i < 30; i++) {
      expect(g.sample(0, 'normal')).toBe(false);
      expect(g.sample(5, 'light')).toBe(false);
      expect(g.sample(5, 'min')).toBe(false);
    }
  });
});

describe('preferências de desempenho', () => {
  it('padrão: automático, sem diagnóstico; valores inválidos caem no padrão', () => {
    expect(DEFAULT_PREFS.perf).toBe('auto');
    expect(DEFAULT_PREFS.perfStats).toBe(false);
    expect(sanitizePrefs({ perf: 'turbo', perfStats: 'sim' }).perf).toBe('auto');
    expect(sanitizePrefs({ perf: 'min', perfStats: true })).toMatchObject({ perf: 'min', perfStats: true });
  });
});
