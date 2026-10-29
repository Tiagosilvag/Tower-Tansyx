// Presença em tempo real (modo de usuários): avisa ao servidor quais agentes estão abertos nesta página e quando você está
// digitando, e mostra quem mais está com cada agente aberto. Só funciona com login (sem usuário nada é enviado nem aparece).
import type { UiContext } from './context';
import { h, setHidden, setText } from './dom';
import { othersOf, presenceLabel, type PresentUser } from './presence-model';
import { avatar } from './users';

const BEAT_MS = 8_000;
const POLL_MS = 4_000;
/** Depois de uma tecla, "digitando" vale por isto. */
const TYPING_MS = 4_000;
/** Aviso extra logo após digitar, mas no máximo neste ritmo. */
const TYPING_BEAT_MS = 2_500;
const MAX_AVATARS = 3;

let meId: (() => number | undefined) | null = null;
let watching: () => string[] = () => [];
let front: () => string | null = () => null;
let map: Record<string, PresentUser[]> = {};
let typingAt = 0;
let typingAgent: string | null = null;
let lastBeat = 0;
let invalidate: () => void = () => undefined;
const strips = new Set<{ agentId: string | null; paint: () => void }>();

function repaint(): void {
  for (const s of strips) s.paint();
}

async function beat(): Promise<void> {
  if (!meId?.()) return;
  lastBeat = Date.now();
  const agents = document.hidden ? [] : watching();
  const typing = typingAgent && Date.now() - typingAt < TYPING_MS && agents.includes(typingAgent) ? typingAgent : undefined;
  try {
    await fetch('/api/presence', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agents, ...(typing ? { typing } : {}) }) });
  } catch {
    // sem rede: o próximo aviso tenta de novo
  }
}

async function poll(): Promise<void> {
  if (!meId?.()) return;
  try {
    const res = await fetch('/api/presence', { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) return;
    const body = (await res.json()) as { presence?: Record<string, PresentUser[]> };
    const next = body.presence && typeof body.presence === 'object' ? body.presence : {};
    const changed = JSON.stringify(next) !== JSON.stringify(map);
    map = next;
    repaint();
    if (changed) invalidate();
  } catch {
    // mantém o que já tinha
  }
}

/** Liga a presença; `me` devolve o id do usuário logado (undefined sem login: nada é enviado). */
export function startPresence(ctx: UiContext, me: () => number | undefined): void {
  meId = me;
  invalidate = () => ctx.invalidate();
  watching = () => (ctx.store.snapshot?.agents ?? []).filter((a) => ctx.terminals?.showing(a.id)).map((a) => a.id);
  front = () => ctx.terminals?.openAgentId ?? null;
  setInterval(() => void beat(), BEAT_MS);
  setInterval(() => void poll(), POLL_MS);
  document.addEventListener(
    'keydown',
    (e) => {
      if (!meId?.() || !(e.target instanceof Element) || !e.target.closest('.ui-term')) return;
      typingAt = Date.now();
      typingAgent = front();
      if (Date.now() - lastBeat > TYPING_BEAT_MS) void beat();
    },
    true,
  );
  void beat().then(poll);
}

/**
 * Só os avatares (sem texto) de quem mais está com o agente aberto, para a linha dele na barra lateral. O texto vai no
 * `title`. Chamado a cada quadro: só mexe no DOM quando a lista muda.
 */
export function paintPresenceFaces(el: HTMLElement, agentId: string): void {
  const others = othersOf(map[agentId], meId?.());
  const key = others.map((u) => `${u.id}:${u.color}:${u.typing ? 1 : 0}`).join('|');
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  setHidden(el, others.length === 0);
  if (!others.length) {
    el.replaceChildren();
    el.removeAttribute('title');
    return;
  }
  const faces = others.slice(0, MAX_AVATARS).map((u) => avatar({ color: u.color, displayName: u.name }, `ui-presence__face${u.typing ? ' is-typing' : ''}`));
  const more = others.length > MAX_AVATARS ? [h('span', { class: 'ui-presence__more', text: `+${others.length - MAX_AVATARS}` })] : [];
  el.replaceChildren(...faces, ...more);
  el.title = presenceLabel(others);
}

/** Faixa com os avatares de quem mais está com o agente aberto e o texto ("ansysar está digitando…"). */
export function presenceStrip(): { el: HTMLElement; set(agentId: string | null): void } {
  const el = h('span', { class: 'ui-presence', hidden: true, role: 'status' });
  const state = {
    agentId: null as string | null,
    paint: () => {
      const others = state.agentId ? othersOf(map[state.agentId], meId?.()) : [];
      setHidden(el, others.length === 0);
      if (!others.length) return;
      const faces = others.slice(0, MAX_AVATARS).map((u) => {
        const a = avatar({ color: u.color, displayName: u.name }, `ui-presence__face${u.typing ? ' is-typing' : ''}`);
        a.title = u.name;
        return a;
      });
      const more = others.length > MAX_AVATARS ? [h('span', { class: 'ui-presence__more', text: `+${others.length - MAX_AVATARS}` })] : [];
      const text = h('span', { class: 'ui-presence__text' });
      setText(text, presenceLabel(others));
      el.replaceChildren(...faces, ...more, text);
    },
  };
  strips.add(state);
  return {
    el,
    set(agentId) {
      if (state.agentId === agentId) return;
      state.agentId = agentId;
      state.paint();
    },
  };
}
