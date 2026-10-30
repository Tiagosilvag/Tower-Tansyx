// Caixa de mensagem: manda um texto ao agente principal pelo Habblaud (POST /api/messages) e o plugin
// habblaud-mensagens o entrega à sessão como se você o tivesse digitado (no Codex, `codex queue` a põe na fila da
// sessão, que a usa quando fica ociosa). Fica na gaveta do agente e no rodapé do
// terminal (só a sessão ao vivo). Enter manda, Shift+Enter quebra a linha; a linha de situação acompanha a entrega
// (GET /api/messages/:id) até ela se resolver. As teclas digitadas aqui não disparam os atalhos globais. O rascunho de
// cada agente fica guardado (só na memória) ao trocar de agente. O microfone (ui/dictation.ts, Whisper local no Mac)
// põe o texto ditado no cursor; aparece quando o ditado funciona daqui. A lógica pura está em ui/composer-model.ts.
import { MESSAGE_MAX } from '../../../shared/messages';
import type { AgentInfo, OutboxMessage, Provider } from '../../../shared/types';
import {
  canSend,
  composerMode,
  composerTip,
  enterSends,
  isSettled,
  LOST_ERROR,
  messageText,
  OFFLINE_ERROR,
  POLL_LIMIT_MS,
  pollDelay,
  sendStatusText,
  timeoutError,
  type ComposerMode,
  type SendState,
} from './composer-model';
import type { UiContext } from './context';
import { DictationButton, dictationAvailable, insertDictation } from './dictation';
import { ICONS } from './icons';
import { attachToMessage, ptyOfAgent, sendPtyKeys } from './ptyapi';
import { PAUSE_KEYS } from './session-info';
import { h, setAttr, setHidden, setText, setTitle } from './dom';
import { access } from '../net/access';
import { tr } from '../../../shared/i18n';

export type ComposerVariant = 'drawer' | 'terminal';

/** De quanto em quanto tempo a sugestão de prompt do Claude Code é consultada enquanto o agente está ocioso. */
const SUGGEST_POLL_MS = 4_000;

export interface ComposerOptions {
  /** Esc dentro da caixa: para onde vai o foco (padrão: só sai da caixa). */
  onEscape?: () => void;
}

export class MessageComposer {
  readonly el: HTMLElement;
  /** Agente da caixa (ou a chave da conversa, no terminal do histórico). */
  private agentId = '';
  private mode: ComposerMode = { kind: 'off', text: '' };
  /** Rascunho por agente: é ele que manda no conteúdo da caixa. */
  private drafts = new Map<string, string>();
  /** Último envio de cada agente (a linha de situação). */
  private states = new Map<string, SendState>();
  /** Ferramenta de cada agente que recebeu mensagem (o texto da entrega e do prazo muda no Codex). */
  private providers = new Map<string, Provider>();
  /** Agentes pausados por aqui: o plugin de mensagens recusa a sessão parada, então a próxima mensagem vai pelo terminal. */
  private paused = new Set<string>();
  /** Último texto mandado pelo plugin a cada agente, para reenviar pelo terminal se a sessão estiver parada. */
  private lastText = new Map<string, string>();
  /** Ferramenta do agente da caixa. */
  private provider: Provider = 'claude';
  /** O que a caixa mostra agora ("<agente>|<pronta>"): ao mudar, o conteúdo vem do rascunho. */
  private shown = '';

  private row: HTMLElement;
  private box: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private hint: HTMLElement;
  private tip: HTMLElement | null;
  private status: HTMLElement;
  private dictate: DictationButton;
  /** Linha do ditado (gravando, transcrevendo, idioma, erro). */
  private dictStatus: HTMLElement;
  private dictTimer: ReturnType<typeof setTimeout> | null = null;
  /** Rascunho que recebe o ditado em andamento (o agente pode mudar enquanto o Mac transcreve). */
  private dictKey = '';
  private attachBtn: HTMLButtonElement;
  /** Só no terminal, com o agente trabalhando: manda Esc para a sessão (precisa do terminal do Habblaud). */
  private pauseBtn: HTMLButtonElement;
  private fileInput: HTMLInputElement;
  /**
   * A sugestão de próximo prompt do Claude Code (o texto cinza do campo de entrada dele, que o Tab aceita), lida da tela
   * do terminal interativo do agente (GET /api/pty/:id/suggestion; só no tmux). Aparece acima da caixa enquanto ela
   * está vazia e o agente ocioso; Tab ou clique a põe na caixa para você ajustar e mandar.
   */
  private suggestBtn: HTMLButtonElement;
  private suggestText: HTMLElement;
  private suggestions = new Map<string, string>();
  /** "<rascunho>|<terminal>" consultado agora ('' = ninguém): mudar para outro encerra a consulta anterior. */
  private suggestKey = '';
  private suggestTimer: ReturnType<typeof setTimeout> | null = null;
  private canDictate = false;

  constructor(
    private ctx: UiContext,
    private variant: ComposerVariant,
    private opts: ComposerOptions = {},
  ) {
    const term = variant === 'terminal';
    this.box = h('textarea', {
      class: `ui-msg__input${term ? ' ui-term__input' : ''}`,
      attrs: { rows: 1, maxlength: MESSAGE_MAX, autocomplete: 'off', enterkeyhint: 'send' },
    });
    this.box.addEventListener('input', () => {
      this.drafts.set(this.agentId, this.box.value);
      this.resize();
      this.syncButton();
      this.paintSuggestion();
    });
    this.box.addEventListener('focus', () => this.resize());
    this.box.addEventListener('keydown', (e) => this.onKey(e));
    this.sendBtn = h(
      'button',
      {
        class: term ? 'ui-msg__send' : 'ui-btn ui-msg__send',
        type: 'button',
        title: tr('Mandar (Enter)'),
        attrs: { 'aria-label': tr('Mandar a mensagem') },
        on: { click: () => void this.send() },
      },
      term ? '↵' : tr('Enviar'),
    );
    this.dictStatus = h('p', { class: 'ui-msg__status ui-msg__dictation', role: 'status', hidden: true, attrs: { 'aria-live': 'polite' } });
    this.dictate = new DictationButton(
      (t) => this.insertDictated(t.text),
      (text, error) => this.sayDictation(text, error),
      { compact: true, onStart: () => (this.dictKey = this.agentId) },
    );
    this.dictate.el.classList.add('ui-msg__mic');
    setHidden(this.dictate.el, true);
    this.fileInput = h('input', { type: 'file', hidden: true, attrs: { multiple: true, 'aria-hidden': 'true', tabindex: '-1' } });
    this.fileInput.addEventListener('change', () => {
      void this.attachFiles([...(this.fileInput.files ?? [])]);
      this.fileInput.value = '';
    });
    this.attachBtn = h('button', {
      class: 'ui-msg__attach',
      type: 'button',
      title: tr('Anexar imagens ou arquivos (ou cole / solte aqui)'),
      attrs: { 'aria-label': tr('Anexar imagens ou arquivos') },
      on: { click: () => this.fileInput.click() },
    });
    const clip = h('span', { attrs: { 'aria-hidden': 'true' } });
    clip.innerHTML = ICONS.attach;
    this.attachBtn.append(clip);
    // Colar (Ctrl+V) ou soltar arquivos na caixa: sobem para o computador e o caminho entra no texto.
    this.box.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (!files.length) return;
      e.preventDefault();
      void this.attachFiles(files);
    });
    this.box.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    });
    this.box.addEventListener('drop', (e) => {
      const files = [...(e.dataTransfer?.files ?? [])];
      if (!files.length) return;
      e.preventDefault();
      void this.attachFiles(files);
    });
    this.suggestText = h('span', { class: 'ui-msg__suggest-text' });
    this.suggestBtn = h(
      'button',
      {
        class: 'ui-msg__suggest',
        type: 'button',
        hidden: true,
        title: tr('Sugestão do Claude Code para o próximo prompt (Tab aceita)'),
        on: { click: () => this.acceptSuggestion() },
      },
      h('span', { class: 'ui-msg__suggest-key', text: 'Tab', attrs: { 'aria-hidden': 'true' } }),
      this.suggestText,
    );
    this.pauseBtn = h(
      'button',
      { class: 'ui-msg__pause', type: 'button', hidden: true, attrs: { 'aria-label': tr('Pausar o agente') } },
      h('span', { class: 'ui-msg__pause-bars', attrs: { 'aria-hidden': 'true' } }, h('i'), h('i')),
      tr('Pausar'),
    );
    this.pauseBtn.addEventListener('click', () => void this.pause());
    this.row = h('div', { class: `ui-msg__row${term ? ' ui-term__prompt ui-term__prompt--mic' : ''}` });
    if (term) this.row.append(h('span', { class: 'ui-term__caret', text: '>', attrs: { 'aria-hidden': 'true' } }));
    this.row.append(this.box, this.attachBtn, this.fileInput, this.dictate.el, this.pauseBtn, this.sendBtn);
    // Clique na "linha do prompt" (fora do botão) põe o cursor na caixa, como num terminal.
    this.row.addEventListener('mousedown', (e) => {
      if (e.target === this.row && !this.box.disabled) {
        e.preventDefault();
        this.box.focus();
      }
    });
    this.hint = h('p', { class: 'ui-msg__hint', hidden: true });
    this.status = h('p', { class: 'ui-msg__status', role: 'status', hidden: true, attrs: { 'aria-live': 'polite' } });
    this.tip = term ? null : h('p', { class: 'ui-msg__tip', text: composerTip() });
    this.el = h('div', { class: `ui-msg ui-msg--${variant}` }, this.hint, this.suggestBtn, this.row, this.dictStatus, this.status, this.tip);
  }

  /**
   * Atualiza a caixa para `agent` (undefined = nenhum: sessão do histórico ou agente que saiu); `key` identifica o
   * rascunho. Devolve o modo: a gaveta esconde a seção quando é 'off'.
   */
  render(agent: AgentInfo | undefined, key = agent?.id ?? ''): ComposerMode['kind'] {
    const store = this.ctx.store;
    const mode = composerMode(agent, {
      enabled: store.mock || !!store.snapshot?.meta.messages,
      local: store.mock || access().messages,
      replaying: store.replaying,
    });
    this.mode = mode;
    const ready = mode.kind === 'ready';
    const term = this.variant === 'terminal';
    this.provider = agent?.provider === 'codex' ? 'codex' : 'claude';

    // Troca de agente (ou a caixa passou a valer/deixou de valer): o conteúdo vem do rascunho guardado.
    const shown = `${key}|${ready}`;
    if (shown !== this.shown) {
      // Gravando para outro agente: para sem transcrever (a fala era para aquele).
      this.dictate.cancel();
      this.shown = shown;
      this.agentId = key;
      this.box.value = ready ? (this.drafts.get(key) ?? '') : '';
      this.box.style.height = '';
      if (ready) requestAnimationFrame(() => this.resize());
    }
    this.box.disabled = !ready;
    const name = agent?.name ?? tr('o agente');
    const placeholder = ready ? (term ? tr('Mensagem para {0} (Enter manda, Shift+Enter quebra a linha)', [name]) : tr('Mensagem para {0}…', [name])) : mode.text;
    setAttr(this.box, 'placeholder', placeholder);
    setAttr(this.box, 'aria-label', ready ? tr('Mensagem para {0}', [name]) : mode.text);
    setTitle(this.box, ready ? '' : mode.text);
    this.row.classList.toggle('is-disabled', !ready);
    setHidden(this.sendBtn, !ready);
    setHidden(this.attachBtn, !ready);
    // Pausar: só no terminal e com o agente trabalhando; sem terminal do Habblaud na sessão fica desligado.
    const pty = agent && term ? ptyOfAgent(this.ctx.store, agent.id) : undefined;
    setHidden(this.pauseBtn, !(term && ready && agent?.status === 'working'));
    this.pauseBtn.disabled = !pty;
    setTitle(this.pauseBtn, pty ? tr('Pausar o que o agente está fazendo (manda Esc para a sessão)') : tr('Para pausar, use "Assumir daqui": só dá para pausar sessões abertas pelo Habblaud'));
    // Consulta em cache (30 s): o Mac pode instalar o Whisper ou parar o auxiliar com a página aberta.
    void dictationAvailable().then((ok) => {
      if (ok === this.canDictate) return;
      this.canDictate = ok;
      this.ctx.invalidate();
    });
    // Transcrevendo: o botão fica até o texto chegar (ele vai para o rascunho de quem ditou).
    setHidden(this.dictate.el, !this.canDictate || (!ready && !this.dictate.busy));
    // Na gaveta, a dica do plugin entra no lugar da caixa; no terminal ela já está no lugar do texto.
    setHidden(this.row, !term && !ready);
    if (this.tip) {
      setHidden(this.tip, !ready);
      setText(this.tip, composerTip(this.provider));
    }
    setHidden(this.hint, term || mode.kind !== 'hint');
    setText(this.hint, mode.kind === 'hint' ? mode.text : '');
    this.syncButton();
    this.syncSuggestion(agent, ready);

    const state = this.states.get(key);
    const text = sendStatusText(state, Date.now(), this.providers.get(key) ?? this.provider);
    setText(this.status, text);
    setHidden(this.status, !text);
    this.status.classList.toggle('is-error', state?.phase === 'failed' || state?.phase === 'rejected');
    this.status.classList.toggle('is-ok', state?.phase === 'delivered');
    return mode.kind;
  }

  // ---------------------------------------------------------------- internos

  private onKey(e: KeyboardEvent): void {
    // Os atalhos globais (F, T, P, /, setas...) não valem dentro da caixa. Com Ctrl/⌘ a tecla segue adiante
    // (Ctrl/⌘+F busca na conversa do terminal; os atalhos globais ignoram essas combinações).
    if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
    // Tab com a caixa vazia e uma sugestão à mostra: aceita (como no terminal do Claude Code).
    if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && this.box.value === '' && this.suggestions.has(this.agentId)) {
      e.preventDefault();
      this.acceptSuggestion();
      return;
    }
    if (e.key === 'Escape') {
      // Esc só sai da caixa (o próximo fecha o terminal ou a gaveta).
      e.preventDefault();
      e.stopPropagation();
      if (this.opts.onEscape) this.opts.onEscape();
      else this.box.blur();
      return;
    }
    if (enterSends(e)) {
      e.preventDefault();
      void this.send();
    }
  }

  /** Texto ditado: no cursor, se a caixa ainda é a de quem ditou; senão, no fim do rascunho daquele agente. */
  private insertDictated(text: string): void {
    const key = this.dictKey;
    if (key === this.agentId && !this.box.disabled) {
      const box = this.box;
      const { value, caret } = insertDictation(box.value, box.selectionStart ?? box.value.length, box.selectionEnd ?? box.value.length, text);
      box.value = value.slice(0, MESSAGE_MAX);
      this.drafts.set(key, box.value);
      this.resize();
      this.syncButton();
      box.focus({ preventScroll: true });
      box.setSelectionRange(caret, caret);
    } else {
      const cur = this.drafts.get(key) ?? '';
      this.drafts.set(key, insertDictation(cur, cur.length, cur.length, text).value.slice(0, MESSAGE_MAX));
    }
  }

  /** Liga ou desliga a consulta da sugestão e pinta o botão (só no chat, com o terminal interativo do agente ocioso). */
  private syncSuggestion(agent: AgentInfo | undefined, ready: boolean): void {
    const ptyId =
      ready && this.variant === 'terminal' && agent && agent.status === 'idle'
        ? this.ctx.store.snapshot?.ptys?.find((p) => p.agentId === agent.id && p.exitedAt === undefined)?.id
        : undefined;
    const key = ptyId ? `${this.agentId}|${ptyId}` : '';
    if (key !== this.suggestKey) {
      if (this.suggestTimer) clearTimeout(this.suggestTimer);
      this.suggestTimer = null;
      // Parou de valer (agente trabalhando, terminal fechado, outro agente): a sugestão antiga não serve mais.
      if (!ptyId) this.suggestions.delete(this.agentId);
      this.suggestKey = key;
      if (ptyId) this.pollSuggestion(key, this.agentId, ptyId);
    }
    this.paintSuggestion();
  }

  private pollSuggestion(key: string, agentKey: string, ptyId: string): void {
    const step = async () => {
      if (this.suggestKey !== key) return;
      try {
        const res = await fetch(`/api/pty/${encodeURIComponent(ptyId)}/suggestion`, { credentials: 'same-origin', cache: 'no-store' });
        // Terminal que não existe mais (404) ou já encerrado (409): para de consultar.
        if (res.status === 404 || res.status === 409) return;
        if (res.ok) {
          const body = (await res.json()) as { suggestion?: unknown };
          const text = typeof body.suggestion === 'string' && body.suggestion ? body.suggestion.slice(0, MESSAGE_MAX) : undefined;
          if (this.suggestKey === key && this.suggestions.get(agentKey) !== text) {
            if (text) this.suggestions.set(agentKey, text);
            else this.suggestions.delete(agentKey);
            this.ctx.invalidate();
          }
        }
      } catch {
        // sem conexão agora: tenta de novo na próxima volta
      }
      if (this.suggestKey === key) this.suggestTimer = setTimeout(() => void step(), SUGGEST_POLL_MS);
    };
    void step();
  }

  private paintSuggestion(): void {
    const text = this.suggestKey ? this.suggestions.get(this.agentId) : undefined;
    const show = !!text && this.box.value === '' && this.mode.kind === 'ready';
    setHidden(this.suggestBtn, !show);
    if (show) setText(this.suggestText, text!);
  }

  /** Põe a sugestão na caixa (para ajustar e mandar com Enter). */
  private acceptSuggestion(): void {
    const text = this.suggestions.get(this.agentId);
    if (!text || this.mode.kind !== 'ready') return;
    this.suggestions.delete(this.agentId);
    const box = this.box;
    box.value = text.slice(0, MESSAGE_MAX);
    this.drafts.set(this.agentId, box.value);
    this.resize();
    this.syncButton();
    this.paintSuggestion();
    box.focus({ preventScroll: true });
    box.setSelectionRange(box.value.length, box.value.length);
  }

  /** Sobe os arquivos e põe os caminhos no texto, depois do que já estava escrito. */
  private async attachFiles(files: File[]): Promise<void> {
    const key = this.agentId;
    if (this.mode.kind !== 'ready' || !files.length) return;
    const paths: string[] = [];
    for (const [i, f] of files.entries()) {
      this.sayDictation(files.length > 1 ? tr('Enviando anexos ({0} de {1})…', [i + 1, files.length]) : tr('Enviando o anexo…'));
      try {
        paths.push(await attachToMessage(f));
      } catch (err) {
        this.sayDictation(`${tr('Anexo não enviado')}: ${f.name || tr('arquivo')} — ${err instanceof Error ? err.message : ''}`, true);
        if (!paths.length) return;
      }
    }
    if (!paths.length) return;
    // Caminhos com espaço vão entre aspas, um por linha.
    const list = paths.map((p) => `${tr('Anexo')}: ${/\s/.test(p) ? `"${p}"` : p}`).join('\n');
    const cur = key === this.agentId ? this.box.value : (this.drafts.get(key) ?? '');
    const next = `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${list}\n`.slice(0, MESSAGE_MAX);
    this.drafts.set(key, next);
    if (key === this.agentId) {
      this.box.value = next;
      this.resize();
      this.syncButton();
      this.box.focus({ preventScroll: true });
    }
    this.sayDictation(paths.length > 1 ? tr('{0} anexos adicionados à mensagem', [paths.length]) : tr('Anexo adicionado à mensagem'));
  }

  private sayDictation(text: string, error = false): void {
    if (this.dictTimer) clearTimeout(this.dictTimer);
    setText(this.dictStatus, text);
    setHidden(this.dictStatus, !text);
    this.dictStatus.classList.toggle('is-error', error);
    // Avisos de sucesso somem sozinhos; "Gravando…" e "Transcrevendo…" ficam até a próxima mudança.
    if (!error && !/…$/.test(text)) this.dictTimer = setTimeout(() => setHidden(this.dictStatus, true), 6_000);
  }

  private syncButton(): void {
    this.sendBtn.disabled = this.mode.kind !== 'ready' || !canSend(this.box.value) || this.states.get(this.agentId)?.phase === 'sending';
  }

  /** Cresce com o texto até o limite do CSS (~6 linhas; depois rola). Escondida, mede quando aparecer. */
  private resize(): void {
    const box = this.box;
    if (!box.isConnected || box.offsetParent === null) return;
    box.style.height = 'auto';
    box.style.height = `${box.scrollHeight + box.offsetHeight - box.clientHeight}px`;
  }

  private setState(agentId: string, state: SendState): void {
    this.states.set(agentId, state);
    if (agentId === this.agentId) this.syncButton();
    this.ctx.invalidate();
  }

  private async pause(): Promise<void> {
    const pty = ptyOfAgent(this.ctx.store, this.agentId);
    if (!pty) return;
    try {
      await sendPtyKeys(pty.id, PAUSE_KEYS);
      this.paused.add(this.agentId);
      this.ctx.announce(tr('Pausa enviada: o agente para e espera a sua próxima mensagem.'));
    } catch (err) {
      this.ctx.announce(`${tr('Não deu para pausar')}: ${err instanceof Error ? err.message : ''}`);
    }
  }

  private async send(): Promise<void> {
    const agentId = this.agentId;
    const raw = this.box.value;
    if (this.mode.kind !== 'ready' || !canSend(raw) || this.states.get(agentId)?.phase === 'sending') return;
    this.providers.set(agentId, this.provider);
    this.setState(agentId, { phase: 'sending', at: Date.now() });
    if (this.paused.has(agentId) && (await this.typeInTerminal(agentId, messageText(raw)))) {
      this.paused.delete(agentId);
      this.afterTyped(agentId, raw);
      return;
    }
    this.lastText.set(agentId, messageText(raw));
    let r: { message: OutboxMessage } | { error: string };
    try {
      r = await this.ctx.store.sendMessage(agentId, messageText(raw));
    } catch {
      r = { error: OFFLINE_ERROR };
    }
    if ('error' in r) {
      // Recusada: o texto continua na caixa para tentar de novo.
      this.setState(agentId, { phase: 'rejected', error: r.error, at: Date.now() });
      return;
    }
    // Na fila: a caixa esvazia (a não ser que você tenha continuado a escrever enquanto o envio ia).
    if ((this.drafts.get(agentId) ?? '') === raw) {
      this.drafts.delete(agentId);
      if (this.agentId === agentId && this.box.value === raw) {
        this.box.value = '';
        this.resize();
      }
    }
    // A sugestão era do turno anterior: o terminal a troca assim que a mensagem entra.
    this.suggestions.delete(agentId);
    this.paintSuggestion();
    const m = r.message;
    this.setState(agentId, { phase: m.status, id: m.id, error: m.error, at: Date.now() });
    if (!isSettled(m.status)) this.poll(agentId, m.id, Date.now());
  }

  /** Digita a mensagem no terminal do Habblaud (o texto e o Enter vão separados, como no Compactar). */
  private async typeInTerminal(agentId: string, text: string): Promise<boolean> {
    const pty = ptyOfAgent(this.ctx.store, agentId);
    if (!pty) return false;
    try {
      await sendPtyKeys(pty.id, text);
      await new Promise((r) => setTimeout(r, 200));
      await sendPtyKeys(pty.id, '\r');
      return true;
    } catch {
      return false;
    }
  }

  private afterTyped(agentId: string, raw: string): void {
    if ((this.drafts.get(agentId) ?? '') === raw) {
      this.drafts.delete(agentId);
      if (this.agentId === agentId && this.box.value === raw) {
        this.box.value = '';
        this.resize();
      }
    }
    this.suggestions.delete(agentId);
    this.paintSuggestion();
    this.setState(agentId, { phase: 'delivered', at: Date.now() });
  }

  /** Consulta a situação até ela se resolver (ou o prazo acabar). Para quando outro envio toma a linha de situação. */
  private poll(agentId: string, id: string, since: number): void {
    const step = async () => {
      if (this.states.get(agentId)?.id !== id) return;
      let m: OutboxMessage | null | undefined;
      try {
        m = await this.ctx.store.messageStatus(id);
      } catch {
        // Sem conexão agora: tenta de novo na próxima volta.
      }
      const cur = this.states.get(agentId);
      if (cur?.id !== id) return;
      const now = Date.now();
      if (m === null) return this.setState(agentId, { phase: 'failed', id, error: LOST_ERROR, at: now });
      // Sessão parada (Esc no terminal): o plugin não entrega; digita a mesma mensagem pelo terminal do Habblaud.
      if (m?.status === 'failed' && /was stopped|nobody has sent input/i.test(m.error ?? '')) {
        const text = this.lastText.get(agentId);
        if (text && (await this.typeInTerminal(agentId, text))) {
          this.lastText.delete(agentId);
          return this.setState(agentId, { phase: 'delivered', at: Date.now() });
        }
      }
      if (m && (m.status !== cur.phase || m.error !== cur.error)) this.setState(agentId, { phase: m.status, id, error: m.error, at: now });
      if (m && isSettled(m.status)) return;
      const elapsed = now - since;
      if (elapsed >= POLL_LIMIT_MS) return this.setState(agentId, { phase: 'failed', id, error: timeoutError(this.providers.get(agentId)), at: now });
      setTimeout(() => void step(), pollDelay(elapsed));
    };
    setTimeout(() => void step(), pollDelay(0));
  }
}
