// Divisões da tela para as janelas móveis (como os "Snap Layouts" do Windows): um seletor na barra de cada janela
// encaixa ela numa zona ou distribui todas as janelas abertas na divisão escolhida.
import { tr } from '../../../shared/i18n';
import { h } from './dom';
import { ICONS } from './icons';
import { Movable, type Box } from './movable';

/** Zona em frações da área de trabalho (0 a 1). */
export interface Zone {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type LayoutId = 'halves' | 'two-thirds' | 'one-third' | 'big-left' | 'big-right' | 'thirds' | 'rows' | 'quarters';

export interface Layout {
  id: LayoutId;
  /** Na ordem em que as janelas ocupam: a mais usada primeiro (esquerda para a direita, de cima para baixo). */
  zones: Zone[];
}

export const LAYOUTS: readonly Layout[] = [
  {
    id: 'halves',
    zones: [
      { x: 0, y: 0, w: 0.5, h: 1 },
      { x: 0.5, y: 0, w: 0.5, h: 1 },
    ],
  },
  {
    id: 'two-thirds',
    zones: [
      { x: 0, y: 0, w: 2 / 3, h: 1 },
      { x: 2 / 3, y: 0, w: 1 / 3, h: 1 },
    ],
  },
  {
    id: 'one-third',
    zones: [
      { x: 0, y: 0, w: 1 / 3, h: 1 },
      { x: 1 / 3, y: 0, w: 2 / 3, h: 1 },
    ],
  },
  {
    id: 'big-left',
    zones: [
      { x: 0, y: 0, w: 0.5, h: 1 },
      { x: 0.5, y: 0, w: 0.5, h: 0.5 },
      { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
    ],
  },
  {
    id: 'big-right',
    zones: [
      { x: 0, y: 0, w: 0.5, h: 0.5 },
      { x: 0.5, y: 0, w: 0.5, h: 1 },
      { x: 0, y: 0.5, w: 0.5, h: 0.5 },
    ],
  },
  {
    id: 'thirds',
    zones: [
      { x: 0, y: 0, w: 1 / 3, h: 1 },
      { x: 1 / 3, y: 0, w: 1 / 3, h: 1 },
      { x: 2 / 3, y: 0, w: 1 / 3, h: 1 },
    ],
  },
  {
    id: 'rows',
    zones: [
      { x: 0, y: 0, w: 1, h: 0.5 },
      { x: 0, y: 0.5, w: 1, h: 0.5 },
    ],
  },
  {
    id: 'quarters',
    zones: [
      { x: 0, y: 0, w: 0.5, h: 0.5 },
      { x: 0.5, y: 0, w: 0.5, h: 0.5 },
      { x: 0, y: 0.5, w: 0.5, h: 0.5 },
      { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
    ],
  },
];

export function layoutTitle(id: LayoutId): string {
  switch (id) {
    case 'halves':
      return tr('Duas colunas iguais');
    case 'two-thirds':
      return tr('Dois terços e um terço');
    case 'one-third':
      return tr('Um terço e dois terços');
    case 'big-left':
      return tr('Uma grande e duas à direita');
    case 'big-right':
      return tr('Duas à esquerda e uma grande');
    case 'thirds':
      return tr('Três colunas');
    case 'rows':
      return tr('Duas linhas');
    case 'quarters':
      return tr('Quatro cantos');
  }
}

/** Margem na borda da tela e vão entre as janelas, em px. */
const MARGIN = 8;
/** Em cima a janela fica colada na barra superior, como quem a puxa para lá na mão. */
const MARGIN_TOP = 0;
const GAP = 8;

/** Zona em pixels dentro da área (a tela abaixo da barra superior), com margem na borda e vão entre as zonas. */
export function zoneBox(z: Zone, area: Box): Box {
  const inner = { x: area.x + MARGIN, y: area.y + MARGIN_TOP, w: area.w - MARGIN * 2, h: area.h - MARGIN - MARGIN_TOP };
  const EPS = 0.001;
  const left = inner.x + z.x * inner.w + (z.x > EPS ? GAP / 2 : 0);
  const top = inner.y + z.y * inner.h + (z.y > EPS ? GAP / 2 : 0);
  const right = inner.x + (z.x + z.w) * inner.w - (z.x + z.w < 1 - EPS ? GAP / 2 : 0);
  const bottom = inner.y + (z.y + z.h) * inner.h - (z.y + z.h < 1 - EPS ? GAP / 2 : 0);
  return { x: Math.round(left), y: Math.round(top), w: Math.round(right - left), h: Math.round(bottom - top) };
}

/** Janela i vai para a zona i; sobra de um lado ou de outro fica como está. */
export function assignZones<T>(windows: readonly T[], zones: readonly Zone[]): Array<[T, Zone]> {
  const out: Array<[T, Zone]> = [];
  for (let i = 0; i < Math.min(windows.length, zones.length); i++) out.push([windows[i]!, zones[i]!]);
  return out;
}

function areaOf(m: Movable): Box {
  const top = m.barHeight();
  const { x, w } = Movable.freeArea();
  return { x, y: top, w, h: Math.max(0, innerHeight - top) };
}

// ------------------------------------------------------------------ seletor

type Mode = 'one' | 'all';

let open: { pop: HTMLElement; anchor: HTMLElement; off: () => void } | null = null;

function closePicker(): void {
  if (!open) return;
  open.off();
  open.pop.remove();
  open.anchor.setAttribute('aria-expanded', 'false');
  open = null;
}

/** Botão da barra da janela que abre o seletor de divisões (o `get` devolve o Movable dela). */
export function layoutButton(get: () => Movable | undefined): HTMLButtonElement {
  const label = tr('Organizar as janelas');
  const b = h('button', {
    class: 'ui-icon-btn ui-icon-btn--sm ui-term__layout',
    type: 'button',
    title: label,
    attrs: { 'aria-label': label, 'aria-haspopup': 'dialog', 'aria-expanded': 'false' },
  });
  b.innerHTML = ICONS.layout;
  b.addEventListener('click', () => {
    const was = open?.anchor === b;
    closePicker();
    const m = get();
    if (!was && m) openPicker(b, m);
  });
  return b;
}

function openPicker(anchor: HTMLButtonElement, m: Movable): void {
  let mode: Mode = 'one';
  const wins = Movable.openWindows();
  const canAll = wins.length > 1;
  const pop = h('div', { class: 'ui-snap', role: 'dialog', attrs: { 'aria-label': tr('Organizar as janelas') } });
  const hint = h('p', { class: 'ui-snap__hint' });
  const grid = h('div', { class: 'ui-snap__grid' });
  const tabs = (['one', 'all'] as const).map((k) => {
    const t = h('button', {
      class: 'ui-snap__tab',
      type: 'button',
      text: k === 'one' ? tr('Esta janela') : tr('Todas as janelas'),
      attrs: { role: 'tab' },
      on: {
        click: () => {
          mode = k;
          paint();
        },
      },
    });
    if (k === 'all' && !canAll) {
      t.disabled = true;
      t.title = tr('Só há uma janela aberta.');
    }
    return t;
  });

  const choose = (zone: Zone, layout: Layout): void => {
    if (mode === 'one') {
      m.snap(zoneBox(zone, areaOf(m)));
    } else {
      m.touch();
      for (const [w, z] of assignZones(Movable.openWindows(), layout.zones)) w.snap(zoneBox(z, areaOf(w)));
    }
    closePicker();
  };

  function paint(): void {
    pop.classList.toggle('is-all', mode === 'all');
    tabs.forEach((t, i) => {
      const on = (i === 0) === (mode === 'one');
      t.classList.toggle('is-on', on);
      t.setAttribute('aria-selected', String(on));
    });
    hint.textContent = mode === 'one' ? tr('Escolha onde encaixar esta janela.') : tr('Escolha a divisão: as janelas abertas se distribuem nela.');
    grid.replaceChildren(
      ...LAYOUTS.map((layout) => {
        const title = layoutTitle(layout.id);
        const box = h('div', { class: 'ui-snap__layout', role: 'group', attrs: { 'aria-label': title }, title });
        for (const [i, z] of layout.zones.entries()) {
          const zone = h('button', {
            class: 'ui-snap__zone',
            type: 'button',
            style: `left:${z.x * 100}%;top:${z.y * 100}%;width:${z.w * 100}%;height:${z.h * 100}%`,
            attrs: { 'aria-label': `${title} · ${i + 1}` },
            on: { click: () => choose(z, layout) },
          });
          box.append(zone);
        }
        return box;
      }),
    );
  }

  pop.append(h('div', { class: 'ui-snap__tabs', role: 'tablist' }, ...tabs), hint, grid);
  paint();
  document.body.append(pop);
  anchor.setAttribute('aria-expanded', 'true');

  const r = anchor.getBoundingClientRect();
  const pw = pop.offsetWidth;
  pop.style.left = `${Math.round(Math.max(8, Math.min(innerWidth - pw - 8, r.right - pw)))}px`;
  pop.style.top = `${Math.round(Math.min(innerHeight - pop.offsetHeight - 8, r.bottom + 6))}px`;

  const onDown = (e: PointerEvent) => {
    if (e.target instanceof Node && (pop.contains(e.target) || anchor.contains(e.target))) return;
    closePicker();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    closePicker();
    anchor.focus();
  };
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  addEventListener('blur', closePicker);
  open = {
    pop,
    anchor,
    off: () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      removeEventListener('blur', closePicker);
    },
  };
}
