import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setQuiet } from '../log';
import { appendLines, L, tempDir, writeLines } from '../test/fixtures';
import { cutAtLine, readEarlier } from './earlier';
import { createTerminalParser } from './terminal';

setQuiet(true);

const limpar: Array<() => void> = [];
afterEach(() => {
  while (limpar.length) limpar.pop()!();
});

function arquivo(n: number): string {
  const t = tempDir();
  limpar.push(t.cleanup);
  const path = join(t.dir, 's.jsonl');
  writeLines(path, Array.from({ length: n }, (_, i) => L.prompt(`pergunta número ${String(i).padStart(3, '0')} com algum texto para ocupar espaço`)));
  return path;
}

const textos = (es: Array<{ kind: string; text?: string }>) => es.filter((e) => e.kind === 'user').map((e) => e.text);

describe('cutAtLine', () => {
  it('corta nas últimas `max` entradas sem partir as de uma mesma linha', () => {
    expect(cutAtLine([0, 10, 20, 30], 2)).toBe(2);
    expect(cutAtLine([0, 10, 10, 10, 30], 2)).toBe(1); // as três da linha 10 ficam juntas
    expect(cutAtLine([0, 10], 5)).toBe(0);
  });
});

describe('readEarlier', () => {
  it('lendo para trás de página em página, devolve toda a conversa, em ordem e sem repetir, até o começo', () => {
    const path = arquivo(60);
    let before = Number.MAX_SAFE_INTEGER;
    const paginas: string[][] = [];
    for (let guarda = 0; guarda < 50; guarda++) {
      const page = readEarlier(path, before, createTerminalParser, { windowBytes: 700, maxEntries: 7 });
      paginas.unshift(textos(page.entries) as string[]);
      if (page.before === 0) break;
      expect(page.before).toBeLessThan(before);
      before = page.before;
    }
    const todas = paginas.flat();
    expect(todas).toHaveLength(60);
    expect(todas).toEqual(Array.from({ length: 60 }, (_, i) => `pergunta número ${String(i).padStart(3, '0')} com algum texto para ocupar espaço`));
    expect(paginas.length).toBeGreaterThan(5);
  });

  it('cada página respeita o máximo de entradas e cabe na janela', () => {
    const path = arquivo(60);
    const page = readEarlier(path, Number.MAX_SAFE_INTEGER, createTerminalParser, { windowBytes: 100_000, maxEntries: 10 });
    expect(page.entries).toHaveLength(10);
    expect(textos(page.entries).at(-1)).toContain('059');
    expect(page.before).toBeGreaterThan(0);
  });

  it('arquivo curto cabe numa página só e termina em 0', () => {
    const path = arquivo(3);
    const page = readEarlier(path, Number.MAX_SAFE_INTEGER, createTerminalParser);
    expect(page.entries).toHaveLength(3);
    expect(page.before).toBe(0);
  });

  it('o ponto de corte é o começo de uma linha: o que foi acrescentado depois não entra', () => {
    const path = arquivo(5);
    const primeira = readEarlier(path, Number.MAX_SAFE_INTEGER, createTerminalParser, { maxEntries: 2 });
    expect(primeira.before).toBeGreaterThan(0);
    appendLines(path, [L.prompt('novidade')]);
    const segunda = readEarlier(path, primeira.before, createTerminalParser, { maxEntries: 10 });
    expect(textos(segunda.entries).join('|')).not.toContain('novidade');
    expect(segunda.entries).toHaveLength(3);
    expect(segunda.before).toBe(0);
  });

  it('before inválido ou maior que o arquivo é limitado ao tamanho; zero não devolve nada', () => {
    const path = arquivo(4);
    expect(readEarlier(path, 0, createTerminalParser).entries).toEqual([]);
    expect(readEarlier(path, 10 ** 12, createTerminalParser).entries).toHaveLength(4);
  });
});
