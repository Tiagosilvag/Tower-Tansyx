import { describe, expect, it } from 'vitest';
import { PRESENT_MS, Presence, TYPING_MS } from './presence';

const ANA = { id: 1, displayName: 'Ana', color: '#fac665' };
const BIA = { id: 2, displayName: 'Bia', color: '#7cc8ff' };

function montar() {
  const clock = { now: 1_000_000 };
  return { clock, p: new Presence(() => clock.now) };
}

describe('Presence', () => {
  it('mostra quem está com cada agente aberto, com nome e cor', () => {
    const { p } = montar();
    p.beat(ANA, ['a:1', 'a:2']);
    p.beat(BIA, ['a:1']);
    const s = p.snapshot();
    expect(s['a:1']!.map((u) => u.name).sort()).toEqual(['Ana', 'Bia']);
    expect(s['a:2']).toEqual([{ id: 1, name: 'Ana', color: '#fac665', typing: false }]);
  });

  it('quem não avisa mais some depois de 20 s', () => {
    const { p, clock } = montar();
    p.beat(ANA, ['a:1']);
    clock.now += PRESENT_MS - 1;
    expect(p.snapshot()['a:1']).toHaveLength(1);
    clock.now += 2;
    expect(p.snapshot()).toEqual({});
  });

  it('o aviso novo substitui a lista: o agente fechado deixa de contar', () => {
    const { p } = montar();
    p.beat(ANA, ['a:1', 'a:2']);
    p.beat(ANA, ['a:2']);
    expect(p.snapshot()['a:1']).toBeUndefined();
    expect(p.snapshot()['a:2']).toHaveLength(1);
  });

  it('digitando vale só no agente indicado e por 6 s', () => {
    const { p, clock } = montar();
    p.beat(ANA, ['a:1', 'a:2'], 'a:1');
    expect(p.snapshot()['a:1']![0]!.typing).toBe(true);
    expect(p.snapshot()['a:2']![0]!.typing).toBe(false);
    clock.now += TYPING_MS;
    expect(p.snapshot()['a:1']![0]!.typing).toBe(false);
  });

  it('digitando num agente que não está na lista é ignorado', () => {
    const { p } = montar();
    p.beat(ANA, ['a:1'], 'a:9');
    expect(p.snapshot()['a:1']![0]!.typing).toBe(false);
  });

  it('leave tira a pessoa na hora', () => {
    const { p } = montar();
    p.beat(ANA, ['a:1']);
    p.leave(1);
    expect(p.snapshot()).toEqual({});
  });

  it('entradas inválidas e listas enormes são cortadas', () => {
    const { p } = montar();
    p.beat(ANA, [1, null, '', 'x'.repeat(500), ...Array.from({ length: 50 }, (_, i) => `a:${i}`)]);
    expect(Object.keys(p.snapshot())).toHaveLength(12);
    p.beat(BIA, 'não é lista');
    expect(p.snapshot()).not.toHaveProperty('não é lista');
  });
});
