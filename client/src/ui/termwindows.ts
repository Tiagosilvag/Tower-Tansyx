// Várias janelas de terminal ao mesmo tempo. Cada "slot" é um par chat (ui/terminal.ts) + interativo (ui/pty.ts) que
// se revezam no mesmo lugar, e cada slot mostra um agente: clicar noutro agente abre outro slot em vez de trocar o
// que está aberto, e clicar de novo num agente que já tem janela só a traz para a frente. Até MAX_WINDOWS janelas
// (depois, a menos recente é reaproveitada); em tela estreita as janelas ocupam a tela toda, então fica uma só.
// É também o roteador (`ctx.terminals`) e a fachada que a gaveta, o histórico e as entregas usam no lugar das duas
// janelas únicas de antes.
import type { RecentSession } from '../../../shared/types';
import type { TerminalRouter, UiComponent, UiContext, WindowOptions } from './context';
import { PtyPanel, type PtyControl } from './pty';
import { TerminalPanel, type TerminalControl } from './terminal';

/** Janelas abertas ao mesmo tempo; passando disso a menos recente é reaproveitada. */
export const MAX_WINDOWS = 4;
/** Cada slot nasce deslocado, em px, para as janelas não ficarem exatamente uma sobre a outra. */
const OFFSET_STEP = 34;
const Z_BASE = 30;

/** O que o slot usa do interativo e do chat (as classes de verdade, ou um substituto nos testes). */
export type SlotPty = Pick<PtyPanel, 'isOpen' | 'agentId' | 'enabled' | 'reason' | 'ptyOf' | 'openAgent' | 'close' | 'takeover' | 'newSession' | 'stop' | 'render'>;
export type SlotChat = Pick<TerminalPanel, 'isOpen' | 'agentId' | 'open' | 'openSession' | 'close' | 'escape' | 'render'>;

export interface TerminalSlot {
  readonly pty: SlotPty;
  readonly chat: SlotChat;
  /** Elementos que entram no DOM. */
  readonly els: HTMLElement[];
  /** Posição na pilha de janelas (0 = a de trás). */
  setZ(level: number): void;
}

export type SlotFactory = (opts: WindowOptions, onFocus: () => void) => TerminalSlot;

export function createSlot(ctx: UiContext, opts: WindowOptions, onFocus: () => void): TerminalSlot {
  const pty = new PtyPanel(ctx, opts);
  const chat = new TerminalPanel(ctx, pty, opts);
  // O interativo aparece no lugar do chat (e vice-versa): a janela de um slot é uma só.
  pty.onShow = () => chat.close();
  const els = [chat.el, pty.el];
  for (const el of els) el.addEventListener('pointerdown', onFocus, true);
  return {
    pty,
    chat,
    els,
    setZ: (level) => {
      for (const el of els) el.style.setProperty('--term-z', String(Z_BASE + level));
    },
  };
}

export class TerminalWindows implements UiComponent, TerminalRouter, TerminalControl, PtyControl {
  private slots: TerminalSlot[] = [];
  /** Do slot mais antigo no foco (0) ao que está na frente. */
  private order: TerminalSlot[] = [];

  constructor(
    private ctx: UiContext,
    /** Coloca os elementos de um slot criado depois da montagem inicial no DOM. */
    private mount: (els: HTMLElement[]) => void,
    private make: SlotFactory = (opts, onFocus) => createSlot(ctx, opts, onFocus),
  ) {
    this.add();
  }

  /** Elementos do primeiro slot (a montagem inicial da interface os coloca no DOM). */
  get els(): HTMLElement[] {
    return this.slots[0].els;
  }

  // ---------------------------------------------------------------- slots

  private add(): TerminalSlot {
    const n = this.slots.length;
    const slot: TerminalSlot = this.make(
      {
        moveKey: n ? `habblaud.move.term.${n}` : undefined,
        offset: n * OFFSET_STEP,
        openAgent: (id) => this.openIn(slot, id),
      },
      () => this.raise(slot),
    );
    this.slots.push(slot);
    this.order.unshift(slot);
    this.restack();
    if (n > 0) this.mount(slot.els);
    return slot;
  }

  private shown(s: TerminalSlot): string | null {
    return s.pty.isOpen ? s.pty.agentId : s.chat.agentId;
  }

  private busy(s: TerminalSlot): boolean {
    return s.pty.isOpen || s.chat.isOpen;
  }

  private slotOf(agentId: string): TerminalSlot | undefined {
    return this.slots.find((s) => this.shown(s) === agentId);
  }

  /** A janela aberta que está mais na frente. */
  private front(): TerminalSlot | undefined {
    for (let i = this.order.length - 1; i >= 0; i--) if (this.busy(this.order[i])) return this.order[i];
    return undefined;
  }

  private raise(s: TerminalSlot): void {
    if (this.order[this.order.length - 1] === s) return;
    this.order = this.order.filter((x) => x !== s);
    this.order.push(s);
    this.restack();
  }

  private restack(): void {
    this.order.forEach((s, i) => s.setZ(i));
  }

  /** Onde abrir um agente novo: um slot livre; senão um slot novo; senão o menos recente. */
  private pick(): TerminalSlot {
    if (this.ctx.isNarrow()) return this.front() ?? this.slots[0];
    const free = this.slots.find((s) => !this.busy(s));
    if (free) return free;
    if (this.slots.length < MAX_WINDOWS) return this.add();
    return this.order[0];
  }

  private closeSlot(s: TerminalSlot): void {
    s.pty.close();
    s.chat.close();
  }

  /** Mostra `id` no slot `s` (o interativo se a sessão roda aqui ou pode rodar; senão o chat). */
  private openIn(s: TerminalSlot, id: string, opener?: HTMLElement | null): void {
    // Já tem janela própria: só traz para a frente, em vez de duplicar (dois terminais na mesma sessão).
    const other = this.slotOf(id);
    if (other && other !== s) return this.raise(other);
    const readOnly = !!this.ctx.store.snapshot?.meta.terminal && !this.ctx.store.replaying;
    if (s.pty.ptyOf(id) || (s.pty.enabled && !readOnly && this.ctx.agent(id)?.kind === 'main')) {
      s.chat.close();
      s.pty.openAgent(id);
    } else {
      s.pty.close();
      s.chat.open(id, opener);
    }
    this.raise(s);
  }

  // ---------------------------------------------------------------- UiComponent

  render(): void {
    for (const s of this.slots) {
      s.chat.render();
      s.pty.render();
    }
  }

  // ---------------------------------------------------------------- TerminalRouter

  get openAgentId(): string | null {
    const f = this.front();
    return f ? this.shown(f) : null;
  }

  showing(agentId: string): boolean {
    return !!this.slotOf(agentId);
  }

  open(agentId: string, opener?: HTMLElement | null): void {
    const have = this.slotOf(agentId);
    if (have) return this.raise(have);
    this.openIn(this.pick(), agentId, opener);
  }

  toggle(agentId: string, opener?: HTMLElement | null): void {
    const s = this.slotOf(agentId);
    if (s) this.closeSlot(s);
    else this.open(agentId, opener);
  }

  interactive(agentId: string): boolean {
    return !!this.slots[0].pty.ptyOf(agentId);
  }

  get available(): boolean {
    return this.enabled || (!!this.ctx.store.snapshot?.meta.terminal && !this.ctx.store.replaying);
  }

  get interactiveEnabled(): boolean {
    return this.enabled;
  }

  get chatAvailable(): boolean {
    return !!this.ctx.store.snapshot?.meta.terminal && !this.ctx.store.replaying;
  }

  switchView(agentId: string): void {
    const s = this.slotOf(agentId);
    if (!s) return;
    if (s.pty.isOpen && s.pty.agentId === agentId) {
      // Interativo → chat: fechar a janela não encerra o pty.
      s.pty.close();
      s.chat.open(agentId);
    } else if (s.pty.ptyOf(agentId)) s.pty.openAgent(agentId);
    this.raise(s);
  }

  newSession(cwd: string, account?: string, resume?: string): Promise<void> {
    const s = this.pick();
    this.raise(s);
    return s.pty.newSession(cwd, account, resume);
  }

  // ---------------------------------------------------------------- TerminalControl e PtyControl

  /** Agente da janela que está na frente. */
  get agentId(): string | null {
    const f = this.front();
    return f ? this.shown(f) : null;
  }

  /** Alguma janela de terminal aberta. */
  get isOpen(): boolean {
    return this.slots.some((s) => this.busy(s));
  }

  /** Alguma janela de chat aberta (o Esc cuida dela). */
  get chatOpen(): boolean {
    return this.slots.some((s) => s.chat.isOpen);
  }

  get enabled(): boolean {
    return this.slots[0].pty.enabled;
  }

  get reason(): string {
    return this.slots[0].pty.reason;
  }

  ptyOf(agentId: string) {
    return this.slots[0].pty.ptyOf(agentId);
  }

  openAgent(agentId: string): void {
    this.open(agentId);
  }

  openSession(session: RecentSession, opener?: HTMLElement | null): void {
    // Ainda aberta e no escritório: o terminal ao vivo do agente (com a janela dele, se já houver).
    if (session.open && session.agentId && this.ctx.agent(session.agentId)) return this.open(session.agentId, opener);
    const s = this.pick();
    s.pty.close();
    s.chat.openSession(session, opener);
    this.raise(s);
  }

  /** Fecha a janela da frente (a sessão do interativo continua rodando). */
  close(): void {
    const f = this.front();
    if (f) this.closeSlot(f);
  }

  closeAll(): void {
    for (const s of this.slots) this.closeSlot(s);
  }

  /** Fecha só os chats (o que lê a conversa de agora não combina com o timelapse). */
  closeChats(): void {
    for (const s of this.slots) s.chat.close();
  }

  /** Esc: o chat que está mais na frente fecha a busca, depois a si mesmo. Devolve false se não havia chat aberto. */
  escape(): boolean {
    for (let i = this.order.length - 1; i >= 0; i--) if (this.order[i].chat.isOpen) return this.order[i].chat.escape();
    return false;
  }

  async takeover(agentId: string): Promise<void> {
    const s = this.slotOf(agentId) ?? this.pick();
    this.raise(s);
    await s.pty.takeover(agentId);
  }

  stop(agentId: string): Promise<void> {
    return this.slots[0].pty.stop(agentId);
  }
}
