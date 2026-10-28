import { describe, expect, it } from 'vitest';
import { buildWordmark, WORDMARK_ROWS } from './icons';

describe('logotipo em pixels', () => {
  it('Tower Tansyx: 8 linhas do mesmo tamanho, "Tower" creme e "Tansyx" âmbar, com sombra', () => {
    expect(WORDMARK_ROWS).toHaveLength(8);
    expect(new Set(WORDMARK_ROWS.map((r) => r.length)).size).toBe(1);
    expect(WORDMARK_ROWS[0].length).toBe(60);
    const all = WORDMARK_ROWS.join('');
    expect(all).toContain('c');
    expect(all).toContain('t');
    expect(all).toContain('s');
    // O primeiro T (creme) vem antes do segundo (âmbar): o topo da linha 0 tem cor de um e depois do outro.
    expect(WORDMARK_ROWS[0].indexOf('c')).toBeLessThan(WORDMARK_ROWS[0].indexOf('t'));
  });

  it('letra desconhecida vira espaço e não quebra', () => {
    const rows = buildWordmark([['T?T', 'c']]);
    expect(rows).toHaveLength(8);
    expect(new Set(rows.map((r) => r.length)).size).toBe(1);
  });
});
