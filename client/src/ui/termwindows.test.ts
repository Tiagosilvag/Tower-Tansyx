import { describe, expect, it } from 'vitest';
import type { UiContext, WindowOptions } from './context';
import { MAX_WINDOWS, TerminalWindows, type TerminalSlot } from './termwindows';

/** Slot de mentira: guarda só o que cada janela mostra e a posição na pilha. */
interface FakeSlot extends TerminalSlot {
  level: number;
  opts: WindowOptions;
  focus: () => void;
}

function setup(opts: { narrow?: boolean; ptys?: string[] } = {}) {
  const ptys = new Set(opts.ptys ?? []);
  const slots: FakeSlot[] = [];
  const mounted: HTMLElement[][] = [];
  const ctx = {
    isNarrow: () => !!opts.narrow,
    agent: (id: string) => ({ id, kind: 'main' }),
    store: { snapshot: { meta: { terminal: true } }, replaying: false },
  } as unknown as UiContext;
  const make = (o: WindowOptions, onFocus: () => void): TerminalSlot => {
    const chat = {
      id: null as string | null,
      get isOpen() {
        return this.id !== null;
      },
      get agentId() {
        return this.id;
      },
      open(id: string) {
        this.id = id;
      },
      openSession() {},
      close() {
        this.id = null;
      },
      escape() {
        this.id = null;
        return true;
      },
      render() {},
    };
    const pty = {
      id: null as string | null,
      enabled: true,
      reason: '',
      get isOpen() {
        return this.id !== null;
      },
      get agentId() {
        return this.id;
      },
      ptyOf: (id: string) => (ptys.has(id) ? ({ agentId: id } as never) : undefined),
      openAgent(id: string) {
        this.id = id;
        chat.close();
      },
      close() {
        this.id = null;
      },
      takeover: async () => {},
      newSession: async () => {},
      stop: async () => {},
      render() {},
    };
    const slot = { pty, chat, els: [], level: 0, opts: o, focus: onFocus, setZ: (n: number) => (slot.level = n) } as unknown as FakeSlot;
    slots.push(slot);
    return slot;
  };
  const wins = new TerminalWindows(ctx, (els) => mounted.push(els), make);
  return { wins, slots, mounted, ptys };
}

describe('TerminalWindows', () => {
  it('abrir outro agente cria outra janela e mantém a primeira aberta', () => {
    const { wins, slots, mounted } = setup();
    wins.open('a');
    wins.open('b');
    expect(slots).toHaveLength(2);
    expect(slots[0].chat.agentId).toBe('a');
    expect(slots[1].chat.agentId).toBe('b');
    expect(wins.showing('a') && wins.showing('b')).toBe(true);
    // O slot novo vai para o DOM, com posição guardada própria e deslocado.
    expect(mounted).toHaveLength(1);
    expect(slots[0].opts.moveKey).toBeUndefined();
    expect(slots[1].opts.moveKey).toBe('habblaud.move.term.1');
    expect(slots[1].opts.offset).toBeGreaterThan(0);
  });

  it('abrir um agente que já tem janela só a traz para a frente', () => {
    const { wins, slots } = setup();
    wins.open('a');
    wins.open('b');
    expect(wins.openAgentId).toBe('b');
    wins.open('a');
    expect(slots).toHaveLength(2);
    expect(wins.openAgentId).toBe('a');
    expect(slots[0].level).toBeGreaterThan(slots[1].level);
  });

  it('clicar na janela (foco) a põe na frente', () => {
    const { wins, slots } = setup();
    wins.open('a');
    wins.open('b');
    slots[0].focus();
    expect(wins.openAgentId).toBe('a');
  });

  it('toggle fecha só a janela daquele agente', () => {
    const { wins } = setup();
    wins.open('a');
    wins.open('b');
    wins.toggle('a');
    expect(wins.showing('a')).toBe(false);
    expect(wins.showing('b')).toBe(true);
    // A janela liberada é reaproveitada antes de criar outra.
    wins.open('c');
    expect(wins.showing('c')).toBe(true);
  });

  it('com o limite de janelas, reaproveita a menos recente', () => {
    const { wins, slots } = setup();
    const ids = Array.from({ length: MAX_WINDOWS + 1 }, (_, i) => `ag${i}`);
    for (const id of ids) wins.open(id);
    expect(slots).toHaveLength(MAX_WINDOWS);
    expect(wins.showing('ag0')).toBe(false);
    expect(wins.showing(ids[MAX_WINDOWS])).toBe(true);
    expect(wins.showing('ag1')).toBe(true);
  });

  it('em tela estreita fica uma janela só (a nova troca a aberta)', () => {
    const { wins, slots } = setup({ narrow: true });
    wins.open('a');
    wins.open('b');
    expect(slots).toHaveLength(1);
    expect(wins.showing('a')).toBe(false);
    expect(wins.showing('b')).toBe(true);
  });

  it('agente com pty abre no interativo; alternar vai e volta no mesmo slot sem encerrar nada', () => {
    const { wins, slots } = setup({ ptys: ['a'] });
    wins.open('a');
    expect(slots[0].pty.agentId).toBe('a');
    wins.switchView('a');
    expect(slots[0].pty.isOpen).toBe(false);
    expect(slots[0].chat.agentId).toBe('a');
    wins.switchView('a');
    expect(slots[0].pty.agentId).toBe('a');
    expect(slots[0].chat.isOpen).toBe(false);
    expect(slots).toHaveLength(1);
  });

  it('a aba de uma janela que aponta para um agente já aberto noutra janela só traz essa para a frente', () => {
    const { wins, slots } = setup();
    wins.open('a');
    wins.open('b');
    slots[0].opts.openAgent?.('b');
    expect(wins.openAgentId).toBe('b');
    expect(slots[0].chat.agentId).toBe('a');
    // Para um agente sem janela, a aba troca o agente da própria janela.
    slots[0].opts.openAgent?.('c');
    expect(slots[0].chat.agentId).toBe('c');
    expect(wins.showing('a')).toBe(false);
  });

  it('showInteractive leva o chat do agente com pty ao interativo e nunca volta ao chat', () => {
    const { wins, slots } = setup({ ptys: ['a'] });
    wins.open('a');
    wins.switchView('a');
    expect(slots[0].chat.agentId).toBe('a');
    wins.showInteractive('a');
    expect(slots[0].pty.agentId).toBe('a');
    expect(slots[0].chat.isOpen).toBe(false);
    // Já no interativo: só traz para a frente, sem alternar de volta.
    wins.showInteractive('a');
    expect(slots[0].pty.agentId).toBe('a');
    expect(slots).toHaveLength(1);
  });

  it('showInteractive de um agente sem janela abre a que o roteador abriria', () => {
    const { wins, slots } = setup({ ptys: ['a'] });
    wins.showInteractive('a');
    expect(slots[0].pty.agentId).toBe('a');
    wins.showInteractive('sem-pty');
    expect(slots[1].chat.agentId).toBe('sem-pty');
  });

  it('Esc fecha o chat que está na frente, um de cada vez', () => {
    const { wins } = setup();
    wins.open('a');
    wins.open('b');
    expect(wins.escape()).toBe(true);
    expect(wins.showing('b')).toBe(false);
    expect(wins.showing('a')).toBe(true);
    expect(wins.escape()).toBe(true);
    expect(wins.escape()).toBe(false);
  });

  it('fechar tudo e fechar só os chats', () => {
    const { wins } = setup({ ptys: ['p'] });
    wins.open('a');
    wins.open('p');
    wins.closeChats();
    expect(wins.showing('a')).toBe(false);
    expect(wins.showing('p')).toBe(true);
    wins.closeAll();
    expect(wins.isOpen).toBe(false);
  });
});
