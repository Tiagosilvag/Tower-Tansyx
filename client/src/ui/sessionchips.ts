// Chips da barra do terminal: o modelo da sessão (com menu para trocar) e o contexto (cartão com as informações da
// sessão). Os dados vêm do AgentInfo; trocar de modelo digita /model no terminal do Habblaud (ui/session-info.ts).
import type { AgentInfo } from '../../../shared/types';
import { intlLocale, tr } from '../../../shared/i18n';
import type { UiContext } from './context';
import { h, setHidden, setText } from './dom';
import { formatDuration } from './format';
import { ptyOfAgent, sendPtyKeys } from './ptyapi';
import { choiceOf, COMPACT_COMMAND, compactTokens, contextPercent, contextWindow, MODEL_CHOICES, modelLabel, switchModelKeys } from './session-info';

const LOCALE = intlLocale();

function isOpen(el: HTMLElement): boolean {
  try {
    return el.matches(':popover-open');
  } catch {
    return el.classList.contains('is-open');
  }
}

function openAt(pop: HTMLElement, anchor: HTMLElement): void {
  const r = anchor.getBoundingClientRect();
  pop.style.top = `${Math.round(r.bottom + 6)}px`;
  pop.style.right = `${Math.max(8, Math.round(innerWidth - r.right))}px`;
  if (typeof pop.showPopover === 'function') pop.showPopover();
  else pop.classList.add('is-open');
}

function close(pop: HTMLElement): void {
  if (typeof pop.hidePopover === 'function') {
    try {
      pop.hidePopover();
    } catch {
      // já fechado
    }
  } else pop.classList.remove('is-open');
}

export class SessionChips {
  readonly el: HTMLElement;
  private readonly modelBtn: HTMLButtonElement;
  private readonly ctxBtn: HTMLButtonElement;
  private readonly ring: HTMLElement;
  private readonly ctxText: HTMLElement;
  private readonly modelPop: HTMLElement;
  private readonly ctxPop: HTMLElement;
  private agent: AgentInfo | null = null;
  private compactTimer: ReturnType<typeof setTimeout> | null = null;
  private compactArmed = false;

  constructor(private readonly ctx: UiContext) {
    this.modelBtn = h('button', { class: 'ui-term__chip', type: 'button', attrs: { 'aria-haspopup': 'dialog', 'aria-expanded': 'false' } });
    this.ring = h('span', { class: 'ui-term__ring', attrs: { 'aria-hidden': 'true' } });
    this.ctxText = h('span');
    this.ctxBtn = h('button', { class: 'ui-term__chip', type: 'button', attrs: { 'aria-haspopup': 'dialog', 'aria-expanded': 'false', title: tr('Contexto da sessão') } }, this.ring, this.ctxText);
    this.modelPop = h('div', { class: 'ui-popover ui-sesspop', role: 'dialog', tabIndex: -1, attrs: { popover: 'auto', 'aria-label': tr('Modelo da sessão') } });
    this.ctxPop = h('div', { class: 'ui-popover ui-sesspop ui-sesspop--ctx', role: 'dialog', tabIndex: -1, attrs: { popover: 'auto', 'aria-label': tr('Contexto da sessão') } });
    this.modelBtn.addEventListener('click', () => this.toggle(this.modelPop, this.modelBtn, () => this.fillModel()));
    this.ctxBtn.addEventListener('click', () => this.toggle(this.ctxPop, this.ctxBtn, () => this.fillCtx()));
    for (const [pop, btn] of [[this.modelPop, this.modelBtn], [this.ctxPop, this.ctxBtn]] as const) {
      pop.addEventListener('toggle', () => btn.setAttribute('aria-expanded', String(isOpen(pop))));
    }
    this.el = h('div', { class: 'ui-term__chips', hidden: true }, this.modelBtn, this.ctxBtn, this.modelPop, this.ctxPop);
  }

  /** `agent` = o agente ao vivo da janela; null (sessão do histórico, agente que saiu) esconde os chips. */
  render(agent: AgentInfo | null): void {
    this.agent = agent;
    const tokens = agent?.contextTokens;
    const label = modelLabel(agent?.model);
    const pct = contextPercent(agent?.model, tokens);
    setHidden(this.el, !agent || (!label && !tokens));
    setHidden(this.modelBtn, !label);
    setText(this.modelBtn, `${label} ▾`);
    setHidden(this.ctxBtn, !tokens);
    setText(this.ctxText, pct === undefined ? '' : `${pct}%`);
    this.ring.style.setProperty('--p', String(pct ?? 0));
    this.ring.classList.toggle('is-high', (pct ?? 0) >= 85);
    // Aberto enquanto os números mudam: refaz o conteúdo.
    if (isOpen(this.ctxPop)) this.fillCtx();
    if (isOpen(this.modelPop)) this.fillModel();
  }

  closeAll(): void {
    close(this.modelPop);
    close(this.ctxPop);
    this.disarmCompact();
  }

  private disarmCompact(): void {
    if (this.compactTimer) clearTimeout(this.compactTimer);
    this.compactTimer = null;
    this.compactArmed = false;
  }

  /** Compactar: dois toques (o primeiro pede a confirmação), porque a conversa passa a valer só pelo resumo. */
  private compactButton(a: AgentInfo): HTMLButtonElement {
    const pty = ptyOfAgent(this.ctx.store, a.id);
    const busy = a.status === 'working' || a.status === 'waiting' || !!pty?.compacting;
    const b = h('button', { class: `ui-sesspop__compact${this.compactArmed ? ' is-confirm' : ''}`, type: 'button', text: this.compactArmed ? tr('Confirmar?') : tr('Compactar') });
    b.disabled = !pty || busy;
    b.title = !pty
      ? tr('Para compactar, use "Assumir daqui": só dá para compactar sessões abertas pelo Habblaud')
      : busy
        ? tr('Espere o agente terminar para compactar.')
        : tr('Compactar a conversa: manda /compact para a sessão (resume o histórico e libera contexto)');
    b.addEventListener('click', () => void this.compact());
    return b;
  }

  private async compact(): Promise<void> {
    const a = this.agent;
    const pty = a ? ptyOfAgent(this.ctx.store, a.id) : undefined;
    if (!pty) return;
    if (!this.compactArmed) {
      this.compactArmed = true;
      this.compactTimer = setTimeout(() => {
        this.disarmCompact();
        if (isOpen(this.ctxPop)) this.fillCtx();
      }, 4000);
      return this.fillCtx();
    }
    this.disarmCompact();
    close(this.ctxPop);
    try {
      // O comando e o Enter vão separados: o Claude Code trata um bloco com Enter no meio como texto colado.
      await sendPtyKeys(pty.id, COMPACT_COMMAND);
      await new Promise((r) => setTimeout(r, 200));
      await sendPtyKeys(pty.id, '\r');
      this.ctx.announce(tr('Compactação pedida: o chat mostra "Compactando a conversa…" até terminar.'));
    } catch (err) {
      this.ctx.announce(`${tr('Não deu para compactar')}: ${err instanceof Error ? err.message : ''}`);
    }
  }

  private toggle(pop: HTMLElement, anchor: HTMLElement, fill: () => void): void {
    if (isOpen(pop)) return close(pop);
    fill();
    openAt(pop, anchor);
  }

  private fillModel(): void {
    const a = this.agent;
    if (!a) return;
    const current = choiceOf(a.model);
    const pty = ptyOfAgent(this.ctx.store, a.id);
    const idle = a.status !== 'working' && a.status !== 'waiting';
    const can = !!pty && idle;
    const items = MODEL_CHOICES.map((c) => {
      const on = c === current;
      const b = h('button', { class: `ui-sesspop__opt${on ? ' is-on' : ''}`, type: 'button' }, h('span', { text: c.label }), h('small', { text: on ? tr('agora') : c.hint }));
      b.disabled = !can || on;
      b.addEventListener('click', () => void this.switchTo(c.id, c.label));
      return b;
    });
    const note = !pty ? tr('Para trocar o modelo, use "Assumir daqui": só dá para trocar em sessões abertas pelo Habblaud.') : !idle ? tr('Espere o agente terminar para trocar o modelo.') : tr('Trocar manda /model para a sessão e vale a partir da próxima resposta.');
    this.modelPop.replaceChildren(...items, h('p', { class: 'ui-sesspop__note', text: note }));
  }

  private async switchTo(modelId: string, label: string): Promise<void> {
    const a = this.agent;
    const pty = a ? ptyOfAgent(this.ctx.store, a.id) : undefined;
    close(this.modelPop);
    if (!pty) return;
    try {
      await sendPtyKeys(pty.id, switchModelKeys(modelId));
      this.ctx.announce(tr('Troca para {0} enviada à sessão: vale a partir da próxima resposta.', [label]));
    } catch (err) {
      this.ctx.announce(`${tr('Não deu para trocar o modelo')}: ${err instanceof Error ? err.message : ''}`);
    }
  }

  private fillCtx(): void {
    const a = this.agent;
    if (!a) return;
    const tokens = a.contextTokens ?? 0;
    const win = contextWindow(a.model, tokens);
    const pct = contextPercent(a.model, tokens) ?? 0;
    const n = (v: number) => v.toLocaleString(LOCALE);
    const rows: [string, string][] = [
      [tr('Modelo'), a.model ?? '—'],
      [tr('Última resposta (entrada)'), n(tokens)],
      [tr('Total da sessão (entrada / saída)'), `${compactTokens(a.stats.tokensIn, LOCALE)} / ${compactTokens(a.stats.tokensOut, LOCALE)}`],
    ];
    if (a.stats.costUSD !== undefined) rows.push([tr('Custo estimado'), `US$ ${a.stats.costUSD.toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`]);
    rows.push([tr('Chamadas de ferramenta'), n(a.stats.toolCalls)], [tr('Subagentes'), n(a.stats.subagents)]);
    if (a.permissionMode) rows.push([tr('Modo de permissão'), a.permissionMode]);
    if (a.gitBranch) rows.push([tr('Branch'), a.gitBranch]);
    rows.push([tr('Iniciada há'), formatDuration(this.ctx.now() - a.startedAt)]);
    const meter = h('div', { class: 'ui-sesspop__meter' }, h('i', { class: pct >= 85 ? 'is-high' : '' }));
    (meter.firstElementChild as HTMLElement).style.width = `${pct}%`;
    this.ctxPop.replaceChildren(
      h('h3', { class: 'ui-sesspop__title', text: tr('Contexto da sessão') }),
      h('div', { class: 'ui-sesspop__sub', text: tr('{0} de {1} tokens ({2}%)', [compactTokens(tokens, LOCALE), compactTokens(win, LOCALE), pct]) }),
      meter,
      h('div', { class: 'ui-sesspop__sub', text: tr('Restam cerca de {0} tokens antes de compactar.', [compactTokens(Math.max(0, win - tokens), LOCALE)]) }),
      this.compactButton(a),
      h('dl', { class: 'ui-sesspop__kv' }, ...rows.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })])),
      h('p', { class: 'ui-sesspop__note', text: tr('Valores lidos do transcript da sessão. A janela de contexto é estimada pelo modelo.') }),
    );
  }
}
