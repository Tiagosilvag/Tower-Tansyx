import { describe, expect, it } from 'vitest';
import { assignZones, LAYOUTS, zoneBox } from './layouts';

const AREA = { x: 0, y: 64, w: 1600, h: 836 };

describe('divisões da tela', () => {
  it('cada zona fica dentro da área e as zonas de uma divisão não se sobrepõem', () => {
    for (const l of LAYOUTS) {
      const boxes = l.zones.map((z) => zoneBox(z, AREA));
      for (const b of boxes) {
        expect(b.x).toBeGreaterThanOrEqual(AREA.x);
        expect(b.y).toBeGreaterThanOrEqual(AREA.y);
        expect(b.x + b.w).toBeLessThanOrEqual(AREA.x + AREA.w);
        expect(b.y + b.h).toBeLessThanOrEqual(AREA.y + AREA.h);
        expect(b.w).toBeGreaterThan(0);
        expect(b.h).toBeGreaterThan(0);
      }
      boxes.forEach((a, i) =>
        boxes.slice(i + 1).forEach((b) => {
          const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
          expect(apart, l.id).toBe(true);
        }),
      );
    }
  });

  it('as zonas cobrem a área inteira (somam 100%)', () => {
    for (const l of LAYOUTS) expect(l.zones.reduce((n, z) => n + z.w * z.h, 0), l.id).toBeCloseTo(1, 5);
  });

  it('duas colunas: margem de 8 px nas laterais, colada na barra em cima e vão de 8 px no meio', () => {
    const [a, b] = LAYOUTS[0]!.zones.map((z) => zoneBox(z, AREA));
    expect(a!.x).toBe(8);
    expect(b!.x - (a!.x + a!.w)).toBe(8);
    expect(b!.x + b!.w).toBe(AREA.w - 8);
    expect(a!.y).toBe(AREA.y);
  });

  it('janela i vai para a zona i; a sobra de um dos lados fica de fora', () => {
    const two = LAYOUTS[0]!.zones;
    expect(assignZones(['a', 'b', 'c'], two).map(([w]) => w)).toEqual(['a', 'b']);
    expect(assignZones(['a'], two)).toHaveLength(1);
    expect(assignZones([], two)).toEqual([]);
  });
});
