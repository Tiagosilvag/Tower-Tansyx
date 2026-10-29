import { describe, expect, it } from 'vitest';
import { othersOf, presenceLabel, type PresentUser } from './presence-model';

const u = (id: number, name: string, typing = false): PresentUser => ({ id, name, color: '#7cc8ff', typing });

describe('presença', () => {
  it('othersOf tira você da lista', () => {
    expect(othersOf([u(1, 'tiago'), u(2, 'ansysar')], 1).map((x) => x.name)).toEqual(['ansysar']);
    expect(othersOf(undefined, 1)).toEqual([]);
  });

  it('o texto diz quem está aqui e quem está digitando', () => {
    expect(presenceLabel([])).toBe('');
    expect(presenceLabel([u(2, 'ansysar')])).toBe('ansysar está aqui');
    expect(presenceLabel([u(2, 'ansysar'), u(3, 'luciano')])).toBe('ansysar e luciano estão aqui');
    expect(presenceLabel([u(2, 'ansysar'), u(3, 'luciano'), u(4, 'bia'), u(5, 'caio')])).toBe('ansysar, luciano e mais 2 estão aqui');
    expect(presenceLabel([u(2, 'ansysar', true)])).toBe('ansysar está digitando…');
    expect(presenceLabel([u(2, 'ansysar', true), u(3, 'luciano')])).toBe('ansysar está digitando…');
    expect(presenceLabel([u(2, 'ansysar', true), u(3, 'luciano', true)])).toBe('ansysar e luciano estão digitando…');
  });
});
