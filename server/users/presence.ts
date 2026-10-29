// Presença em tempo real: quem está com a conversa ou o terminal de um agente aberto e quem está digitando. Só na memória:
// cada página avisa a cada poucos segundos o que está olhando (POST /api/presence) e quem não avisa mais some sozinho.
// Nada disso vai ao agente nem ao banco.

/** Sem aviso por este tempo, a pessoa saiu. A página avisa a cada ~8 s. */
export const PRESENT_MS = 20_000;
/** "Digitando" dura isto depois do último aviso com a tecla. */
export const TYPING_MS = 6_000;
const MAX_AGENTS_PER_BEAT = 12;
const AGENT_ID_MAX = 200;
const MAX_USERS = 200;

export interface PresentUser {
  id: number;
  name: string;
  color: string;
  typing: boolean;
}

interface Seen {
  name: string;
  color: string;
  /** agente → hora do último aviso */
  agents: Map<string, number>;
  typing?: { agent: string; at: number };
}

export class Presence {
  private readonly users = new Map<number, Seen>();

  constructor(private readonly now: () => number = Date.now) {}

  /** `agents`: o que a pessoa está olhando agora; `typing`: o agente em que ela digitou há instantes. */
  beat(user: { id: number; displayName: string; color: string }, agents: unknown, typing?: unknown): void {
    const now = this.now();
    const ids = (Array.isArray(agents) ? agents : [])
      .filter((a): a is string => typeof a === 'string' && a.length > 0 && a.length <= AGENT_ID_MAX)
      .slice(0, MAX_AGENTS_PER_BEAT);
    let s = this.users.get(user.id);
    if (!s) {
      if (this.users.size >= MAX_USERS) this.sweep(now);
      if (this.users.size >= MAX_USERS) return;
      s = { name: user.displayName, color: user.color, agents: new Map() };
      this.users.set(user.id, s);
    }
    s.name = user.displayName;
    s.color = user.color;
    // o aviso novo substitui a lista: o que a pessoa fechou deixa de contar na hora
    s.agents = new Map(ids.map((id) => [id, now]));
    if (typeof typing === 'string' && ids.includes(typing)) s.typing = { agent: typing, at: now };
    else delete s.typing;
  }

  /** Quem a página saiu (fechou a aba): some na hora. */
  leave(userId: number): void {
    this.users.delete(userId);
  }

  /** agente → quem está com ele aberto (inclui quem pergunta; a página filtra a si mesma). */
  snapshot(): Record<string, PresentUser[]> {
    const now = this.now();
    this.sweep(now);
    const out: Record<string, PresentUser[]> = {};
    for (const [id, s] of this.users) {
      for (const agent of s.agents.keys()) {
        const typing = !!s.typing && s.typing.agent === agent && now - s.typing.at < TYPING_MS;
        (out[agent] ??= []).push({ id, name: s.name, color: s.color, typing });
      }
    }
    return out;
  }

  private sweep(now: number): void {
    for (const [id, s] of this.users) {
      for (const [agent, at] of s.agents) if (now - at >= PRESENT_MS) s.agents.delete(agent);
      if (s.agents.size === 0) this.users.delete(id);
    }
  }
}
