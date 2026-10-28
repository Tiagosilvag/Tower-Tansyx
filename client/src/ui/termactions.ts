// Botões do topo da janela de terminal: "Assumir daqui" (sessão aberta noutro terminal: encerra lá e continua a
// mesma conversa aqui, interativa) e "Encerrar". Os dois pedem um segundo clique.
// Só para agentes principais reais (os do demo não têm processo) e com o terminal interativo ligado.
import type { AgentInfo, RecentSession } from '../../../shared/types';
import type { UiContext } from './context';
import { h, setHidden, setText, setTitle } from './dom';
import type { PtyControl } from './pty';
import { ptyControllable } from './ptyapi';
import { tr } from '../../../shared/i18n';

const CONFIRM_MS = 4000;

type Kind = 'stop' | 'takeover';

/** O que basta para retomar: a pasta do projeto, a conta e o id da sessão. */
export type ResumableSession = Pick<RecentSession, 'account' | 'sessionId' | 'project'>;

export class TermActions {
  readonly el: HTMLElement;
  private agent: AgentInfo | null = null;
  private takeBtn: HTMLButtonElement;
  private resumeBtn: HTMLButtonElement;
  private viewBtn: HTMLButtonElement;
  private session: ResumableSession | null = null;
  private stopBtn: HTMLButtonElement;
  private msg: HTMLElement;
  private confirm: Kind | null = null;
  private confirmTimer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;

  constructor(
    private ctx: UiContext,
    private pty: PtyControl,
    /** Mostrar "Assumir daqui" (sessão aberta noutro terminal). */
    public withTakeover: boolean,
    /** Encerrar este agente (padrão: pela API; no interativo, fecha o pty). */
    private onStop?: (agent: AgentInfo) => Promise<void>,
  ) {
    this.takeBtn = h('button', { class: 'ui-btn ui-btn--sm ui-btn--accent', type: 'button', on: { click: () => this.run('takeover') } });
    setTitle(this.takeBtn, tr('Encerra a sessão no terminal onde ela está e continua a mesma conversa aqui, podendo digitar'));
    this.stopBtn = h('button', { class: 'ui-btn ui-btn--sm ui-btn--danger', type: 'button', on: { click: () => this.run('stop') } });
    setTitle(this.stopBtn, tr('Encerra esta sessão do Claude Code (a conversa fica salva)'));
    this.resumeBtn = h('button', { class: 'ui-btn ui-btn--sm ui-btn--accent', type: 'button', on: { click: () => this.runResume() } });
    setTitle(this.resumeBtn, tr('Abre esta conversa de novo num terminal daqui, de onde ela parou'));
    this.viewBtn = h('button', { class: 'ui-btn ui-btn--sm', type: 'button', on: { click: () => this.switchView() } });
    this.msg = h('span', { class: 'ui-termact__msg', role: 'status', hidden: true });
    this.el = h('span', { class: 'ui-termact', hidden: true }, this.msg, this.resumeBtn, this.viewBtn, this.takeBtn, this.stopBtn);
  }

  /**
   * `agent` = agente presente na janela (null = sessão do histórico, saiu ou nenhum). `session` = sessão encerrada
   * aberta no histórico: sem agente vivo, mas com pasta e conta para retomar a conversa.
   */
  render(agent: AgentInfo | null, session: ResumableSession | null = null): void {
    if (agent?.id !== this.agent?.id) {
      this.resetConfirm();
      this.showMsg('');
    }
    this.agent = agent;
    const usable = ptyControllable(agent) && this.pty.enabled;
    // Retomar só faz sentido sem agente vivo e com a pasta do projeto conhecida (o transcript nem sempre a traz).
    this.session = !agent && session?.project ? session : null;
    const canResume = !!this.session && this.pty.enabled;
    setHidden(this.el, !usable && !canResume);
    setHidden(this.resumeBtn, !canResume);
    if (canResume) {
      setText(this.resumeBtn, tr('Retomar'));
      this.resumeBtn.disabled = this.busy;
    }
    // Alterna entre o chat e o terminal interativo do mesmo agente, sem encerrar nada. No chat só aparece quando o
    // agente já tem pty (senão o caminho é "Assumir daqui"); no interativo, quando o chat está disponível.
    const router = this.ctx.terminals;
    const toTerminal = this.withTakeover;
    const canSwitch = usable && !!agent && !!router && (toTerminal ? router.interactive(agent.id) : router.chatAvailable);
    setHidden(this.viewBtn, !canSwitch);
    if (canSwitch) {
      setText(this.viewBtn, toTerminal ? tr('Terminal') : tr('Chat'));
      setTitle(
        this.viewBtn,
        toTerminal
          ? tr('Mostra o terminal interativo desta sessão (nada é encerrado)')
          : tr('Mostra a conversa em formato de chat, com a caixa de mensagem (o terminal continua rodando)'),
      );
    }
    setHidden(this.takeBtn, !usable || !this.withTakeover);
    setHidden(this.stopBtn, !usable);
    if (!usable) return;
    setText(this.takeBtn, this.confirm === 'takeover' ? tr('Confirmar?') : tr('Assumir daqui'));
    setText(this.stopBtn, this.confirm === 'stop' ? tr('Confirmar?') : tr('Encerrar'));
    this.takeBtn.classList.toggle('is-confirm', this.confirm === 'takeover');
    this.stopBtn.classList.toggle('is-confirm', this.confirm === 'stop');
    this.takeBtn.disabled = this.busy;
    this.stopBtn.disabled = this.busy;
  }

  private switchView(): void {
    if (this.agent) this.ctx.terminals?.switchView(this.agent.id);
  }

  /** Retomar não pede confirmação: não encerra nada nem perde conversa, só abre a mesma de novo. */
  private runResume(): void {
    const s = this.session;
    if (!s?.project || this.busy) return;
    this.resetConfirm();
    this.busy = true;
    this.showMsg(tr('Retomando…'));
    this.ctx.invalidate();
    this.pty
      .newSession(s.project, s.account, s.sessionId)
      .then(() => this.showMsg(''))
      .catch((err: Error) => this.showMsg(tr('Não deu: {0}', [err.message]), true))
      .finally(() => {
        this.busy = false;
        this.ctx.invalidate();
      });
  }

  private run(kind: Kind): void {
    const a = this.agent;
    if (!a || this.busy) return;
    if (this.confirm !== kind) {
      this.resetConfirm();
      this.confirm = kind;
      this.confirmTimer = setTimeout(() => {
        this.resetConfirm();
        this.ctx.invalidate();
      }, CONFIRM_MS);
      this.ctx.invalidate();
      return;
    }
    this.resetConfirm();
    this.busy = true;
    this.showMsg(kind === 'stop' ? tr('Encerrando…') : tr('Assumindo…'));
    this.ctx.invalidate();
    const job = kind === 'stop' ? (this.onStop ? this.onStop(a) : this.pty.stop(a.id)) : this.pty.takeover(a.id);
    job
      .then(() => this.showMsg(''))
      .catch((err: Error) => this.showMsg(tr('Não deu: {0}', [err.message]), true))
      .finally(() => {
        this.busy = false;
        this.ctx.invalidate();
      });
  }

  private showMsg(text: string, error = false): void {
    setText(this.msg, text);
    setHidden(this.msg, !text);
    setTitle(this.msg, text);
    this.msg.classList.toggle('is-error', error);
  }

  private resetConfirm(): void {
    if (this.confirmTimer) clearTimeout(this.confirmTimer);
    this.confirmTimer = null;
    this.confirm = null;
  }
}
