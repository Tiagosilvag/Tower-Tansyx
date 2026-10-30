import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompactionWatch, COMPACTION_TTL_MS } from './compaction';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function montar() {
  const eventos: boolean[] = [];
  const w = new CompactionWatch((a) => eventos.push(a));
  return { w, eventos };
}

describe('CompactionWatch', () => {
  it('vê a frase da compactação e avisa uma vez', () => {
    const { w, eventos } = montar();
    w.feed('\x1b[35m✻\x1b[39m Compacting conversation… (42s · ↓ 3.6k tokens)');
    w.feed('\r\x1b[2K✻ Compacting conversation… (43s · ↓ 3.7k tokens)');
    expect(w.active).toBe(true);
    expect(eventos).toEqual([true]);
  });

  it('acha a frase mesmo com escapes no meio e dividida em duas partes', () => {
    const { w, eventos } = montar();
    w.feed('✻ Compacting con');
    w.feed('\x1b[1mversation\x1b[22m… (3s)');
    expect(eventos).toEqual([true]);
  });

  it('some sozinha quando a linha para de aparecer', () => {
    const { w, eventos } = montar();
    w.feed('Compacting conversation…');
    vi.advanceTimersByTime(COMPACTION_TTL_MS - 1);
    expect(w.active).toBe(true);
    w.feed('Compacting conversation…'); // redesenho: renova o prazo
    vi.advanceTimersByTime(COMPACTION_TTL_MS - 1);
    expect(w.active).toBe(true);
    vi.advanceTimersByTime(2);
    expect(w.active).toBe(false);
    expect(eventos).toEqual([true, false]);
  });

  it('texto comum, e a frase já vista, não reacendem', () => {
    const { w, eventos } = montar();
    w.feed('Pensando… Compactação de arquivos e Compacting files');
    expect(eventos).toEqual([]);
    w.feed('Compacting conversation…');
    vi.advanceTimersByTime(COMPACTION_TTL_MS + 1);
    w.feed('outra coisa qualquer');
    expect(eventos).toEqual([true, false]);
  });

  it('acha a frase quando o espaço vem como movimento do cursor', () => {
    const { w, eventos } = montar();
    w.feed('✻ Compacting\x1b[1Cconversation…');
    expect(eventos).toEqual([true]);
  });

  describe('com a tela do terminal', () => {
    const linha = '✻ Compacting conversation… (1m 10s · ↓ 4.6k tokens)';

    it('continua ativa enquanto a linha está na tela, mesmo sem redesenho', () => {
      let tela = linha;
      const eventos: boolean[] = [];
      const w = new CompactionWatch((a) => eventos.push(a), undefined, () => tela);
      w.feed('Compacting conversation…');
      vi.advanceTimersByTime(COMPACTION_TTL_MS * 3);
      expect(w.active).toBe(true);
      tela = 'Conversation compacted';
      vi.advanceTimersByTime(COMPACTION_TTL_MS);
      expect(eventos).toEqual([true, false]);
    });

    it('vê a linha na tela mesmo quando a frase não passou pelo fluxo', () => {
      const eventos: boolean[] = [];
      const w = new CompactionWatch((a) => eventos.push(a), undefined, () => `\x1b[35m${linha}\x1b[39m`);
      w.feed('1m 10s');
      expect(eventos).toEqual([true]);
    });

    it('texto que só cita a frase, sem contador, não conta na tela', () => {
      const eventos: boolean[] = [];
      const w = new CompactionWatch((a) => eventos.push(a), undefined, () => 'falamos do Compacting conversation hoje');
      w.feed('qualquer coisa');
      expect(eventos).toEqual([]);
    });

    it('não consulta a tela mais de uma vez por intervalo', () => {
      const probe = vi.fn(() => '');
      const w = new CompactionWatch(() => {}, undefined, probe);
      w.feed('a');
      w.feed('b');
      expect(probe).toHaveBeenCalledTimes(1);
    });
  });

  it('dispose cancela o prazo sem avisar', () => {
    const { w, eventos } = montar();
    w.feed('Compacting conversation…');
    w.dispose();
    vi.advanceTimersByTime(COMPACTION_TTL_MS * 2);
    expect(eventos).toEqual([true]);
    expect(w.active).toBe(false);
  });
});
