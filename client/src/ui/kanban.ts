// Kanban do time: o quadro branco da parede da sala, com uma estante de projetos ao lado (retrátil) e post-its nas colunas.
// Dados de /api/kanban/* (net/kanban.ts). Tudo que o usuário escreve entra como texto (h/setText), nunca como HTML.
// Aqui: ver quadros e cartões, as duas buscas, criar projeto e cartão. Abrir, editar e arrastar cartões vêm na etapa seguinte.
import { tr } from '../../../shared/i18n';
import { COLUMNS, MAX_BOARD_NAME, MAX_TITLE, type Column, type KanbanBoard, type KanbanCard } from '../../../shared/kanban';
import { kanbanApi } from '../net/kanban';
import type { UiComponent, UiContext } from './context';
import { h, iconButton, setHidden, setText } from './dom';
import { ICONS } from './icons';
import { filterBoards, filterCards, groupByColumn, loadShelf, saveShelf, type ShelfState } from './kanban-model';

const COLUMN_LABEL: Record<Column, string> = { ideias: tr('Ideias'), a_fazer: tr('A fazer'), fazendo: tr('Fazendo'), feito: tr('Feito') };
const PRIORITY_LABEL = { alta: tr('alta'), media: tr('média'), baixa: tr('baixa') } as const;
/** Cores dos post-its e das lombadas, em rodízio. */
const TINTS = ['y', 'p', 'm', 'b'] as const;

export class KanbanPanel implements UiComponent {
  readonly el: HTMLDialogElement;
  private boards: KanbanBoard[] = [];
  private cards: KanbanCard[] = [];
  private boardId: number | null = null;
  private shelf: ShelfState;
  private collapsed: boolean;
  private qProj = '';
  private qTask = '';
  private error: string | null = null;
  private loading = false;
  private seq = 0;
  private addingCard: Column | null = null;
  private addingProject = false;
  private selectedId: number | null = null;
  private opener: HTMLElement | null = null;

  private readonly shelfEl: HTMLElement;
  private readonly shelfList: HTMLElement;
  private readonly fold: HTMLButtonElement;
  private readonly titleEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly statusText: HTMLElement;
  private readonly retry: HTMLButtonElement;
  private readonly emptyEl: HTMLElement;
  private readonly cols: HTMLElement;
  private readonly searchTask: HTMLInputElement;
  private readonly searchProj: HTMLInputElement;

  /** `button` = o botão do Kanban na barra superior (ui/kanban-launcher.ts), que reflete se a janela está aberta. */
  constructor(
    private readonly ctx: UiContext,
    private readonly button: HTMLElement,
  ) {
    this.shelf = loadShelf();
    // Em tela estreita a estante nasce recolhida (e essa escolha não é gravada: só o toque do usuário grava).
    this.collapsed = this.shelf.collapsed || ctx.isNarrow();

    this.searchTask = h('input', { class: 'ui-kb__input', type: 'search', attrs: { placeholder: tr('Buscar tarefas neste quadro…'), 'aria-label': tr('Buscar tarefas'), autocomplete: 'off', maxlength: 100 } });
    this.searchTask.addEventListener('input', () => {
      this.qTask = this.searchTask.value;
      this.renderBoard();
    });
    this.searchProj = h('input', { class: 'ui-kb__input', type: 'search', attrs: { placeholder: tr('Buscar projeto…'), 'aria-label': tr('Buscar projeto'), autocomplete: 'off', maxlength: 100 } });
    this.searchProj.addEventListener('input', () => {
      this.qProj = this.searchProj.value;
      this.renderShelf();
    });

    this.fold = h('button', { class: 'ui-kb__fold', type: 'button', on: { click: () => this.toggleShelf() } });
    this.shelfList = h('div', { class: 'ui-kb__shelf-list' });
    this.shelfEl = h(
      'nav',
      { class: 'ui-kb__shelf', attrs: { 'aria-label': tr('Estante de projetos') } },
      h('div', { class: 'ui-kb__shelf-head' }, h('span', { class: 'ui-kb__label', text: tr('Estante') }), this.fold),
      h('label', { class: 'ui-kb__search ui-kb__search--small' }, h('span', { text: '⌕', attrs: { 'aria-hidden': 'true' } }), this.searchProj),
      this.shelfList,
    );

    this.titleEl = h('span', { class: 'ui-kb__board-name' });
    const close = iconButton(ICONS.close, tr('Fechar (Esc)'), () => this.close(), 'ui-icon-btn--sm');
    this.statusText = h('span', {});
    this.retry = h('button', { class: 'ui-link-btn', type: 'button', text: tr('Tentar de novo'), hidden: true, on: { click: () => void this.load() } });
    this.statusEl = h('p', { class: 'ui-kb__status', attrs: { role: 'status', 'aria-live': 'polite' } }, this.statusText, this.retry);
    this.emptyEl = h('p', { class: 'ui-kb__empty', hidden: true });
    this.cols = h('div', { class: 'ui-kb__cols' });

    this.el = h(
      'dialog',
      { class: 'ui-dialog ui-kb', attrs: { 'aria-labelledby': 'ui-kb-title' } },
      h(
        'div',
        { class: 'ui-kb__room' },
        h(
          'div',
          { class: 'ui-kb__board' },
          h(
            'div',
            { class: 'ui-kb__bar' },
            h('h2', { class: 'ui-kb__title', text: tr('Kanban'), attrs: { id: 'ui-kb-title' } }),
            this.titleEl,
            h('label', { class: 'ui-kb__search' }, h('span', { text: '⌕', attrs: { 'aria-hidden': 'true' } }), this.searchTask),
            close,
          ),
          h('div', { class: 'ui-kb__layout' }, this.shelfEl, h('div', { class: 'ui-kb__main' }, this.statusEl, this.emptyEl, this.cols)),
        ),
      ),
    );
    // Clique no fundo fecha; o teclado fica dentro da janela (os atalhos do escritório não disparam por baixo).
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.close();
    });
    this.el.addEventListener('keydown', (e) => e.stopPropagation());
    this.el.addEventListener('close', () => this.onClosed());
    this.applyFold();
  }

  get isOpen(): boolean {
    return this.el.open;
  }

  open(): void {
    if (this.el.open) return;
    this.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.el.showModal();
    this.button.setAttribute('aria-expanded', 'true');
    void this.load();
  }

  close(): void {
    if (this.el.open) this.el.close();
  }

  toggle(): void {
    if (this.el.open) this.close();
    else this.open();
  }

  render(): void {
    // Nada a reconciliar por quadro: os dados só mudam quando o usuário age ou reabre a janela.
  }

  private onClosed(): void {
    this.seq++;
    this.button.setAttribute('aria-expanded', 'false');
    if (this.opener?.isConnected) this.opener.focus({ preventScroll: true });
    this.opener = null;
  }

  // ---------------------------------------------------------------- dados

  private get board(): KanbanBoard | undefined {
    return this.boards.find((b) => b.id === this.boardId);
  }

  private async load(): Promise<void> {
    const seq = ++this.seq;
    this.loading = true;
    this.error = null;
    this.renderStatus();
    try {
      const boards = await kanbanApi.boards();
      if (seq !== this.seq) return;
      this.boards = boards;
      const want = this.boardId ?? this.shelf.boardId;
      this.boardId = boards.find((b) => b.id === want)?.id ?? boards[0]?.id ?? null;
      this.cards = this.boardId === null ? [] : await kanbanApi.cards(this.boardId);
      if (seq !== this.seq) return;
    } catch (err) {
      if (seq !== this.seq) return;
      this.error = (err as Error).message;
    }
    this.loading = false;
    this.renderAll();
  }

  /** Recarrega os cartões do quadro aberto e as contagens da estante, sem apagar a tela enquanto espera. */
  private async refresh(): Promise<void> {
    const seq = ++this.seq;
    try {
      const [boards, cards] = await Promise.all([kanbanApi.boards(), this.boardId === null ? Promise.resolve([]) : kanbanApi.cards(this.boardId)]);
      if (seq !== this.seq) return;
      this.boards = boards;
      this.cards = cards;
      this.error = null;
    } catch (err) {
      if (seq !== this.seq) return;
      this.error = (err as Error).message;
    }
    this.renderAll();
  }

  private selectBoard(id: number): void {
    if (id === this.boardId) return;
    this.boardId = id;
    this.shelf = { ...this.shelf, boardId: id };
    saveShelf(this.shelf);
    this.qTask = '';
    this.searchTask.value = '';
    this.addingCard = null;
    this.selectedId = null;
    this.cards = [];
    this.renderAll();
    void this.refresh();
  }

  private toggleShelf(): void {
    this.collapsed = !this.collapsed;
    this.shelf = { ...this.shelf, collapsed: this.collapsed };
    saveShelf(this.shelf);
    this.applyFold();
  }

  private applyFold(): void {
    this.el.classList.toggle('ui-kb--collapsed', this.collapsed);
    this.fold.textContent = this.collapsed ? '▶' : '◀';
    const label = this.collapsed ? tr('Abrir a estante') : tr('Recolher a estante');
    this.fold.setAttribute('aria-label', label);
    this.fold.title = label;
    this.fold.setAttribute('aria-expanded', String(!this.collapsed));
  }

  private async createCard(column: Column, title: string): Promise<void> {
    if (this.boardId === null) return;
    try {
      await kanbanApi.createCard(this.boardId, { title, column });
      this.addingCard = null;
      await this.refresh();
    } catch (err) {
      this.say((err as Error).message);
    }
  }

  private async createProject(name: string): Promise<void> {
    try {
      const board = await kanbanApi.createBoard(name);
      this.addingProject = false;
      this.boards = [...this.boards, board];
      this.selectBoard(board.id);
    } catch (err) {
      this.say((err as Error).message);
    }
  }

  // ---------------------------------------------------------------- tela

  private say(message: string): void {
    this.error = message;
    this.renderStatus();
  }

  private renderAll(): void {
    this.renderStatus();
    this.renderShelf();
    this.renderBoard();
  }

  private renderStatus(): void {
    setText(this.statusText, this.error ?? (this.loading ? tr('Carregando…') : ''));
    this.statusEl.classList.toggle('is-error', !!this.error);
    setHidden(this.statusEl, !this.error && !this.loading);
    setHidden(this.retry, !this.error);
  }

  private renderShelf(): void {
    const shown = filterBoards(this.boards, this.qProj);
    const general = shown.find((b) => b.kind === 'general');
    const projects = shown.filter((b) => b.kind === 'project');
    const items: HTMLElement[] = [];
    if (general) items.push(this.shelfItem(general, 'ui-kb__gen', '◆ '));
    items.push(h('span', { class: 'ui-kb__label', text: tr('Projetos') }));
    projects.forEach((b, i) => items.push(this.shelfItem(b, `ui-kb__book ui-kb__book--${TINTS[i % TINTS.length]}`)));
    const hasProjects = this.boards.some((b) => b.kind === 'project');
    if (!projects.length) items.push(h('p', { class: 'ui-kb__hint', text: hasProjects ? tr('Nenhum projeto encontrado.') : tr('Nenhum projeto ainda. Crie o primeiro abaixo.') }));
    items.push(this.projectAdder());
    this.shelfList.replaceChildren(...items);
    if (this.addingProject) this.shelfList.querySelector<HTMLInputElement>('input')?.focus();
  }

  private shelfItem(b: KanbanBoard, cls: string, mark = ''): HTMLElement {
    const active = b.id === this.boardId;
    const btn = h(
      'button',
      { class: `${cls}${active ? ' is-on' : ''}`, type: 'button', title: `${b.name} · ${b.openCount}`, attrs: { 'aria-current': active ? 'true' : undefined } },
      h('span', { class: 'ui-kb__spine', text: Array.from(b.name)[0]?.toUpperCase() ?? '?', attrs: { 'aria-hidden': 'true' } }),
      h('span', { class: 'ui-kb__name', text: mark + b.name }),
      h('b', { class: 'ui-kb__count', text: String(b.openCount), attrs: { 'aria-label': tr('{0} abertos', [b.openCount]) } }),
    );
    btn.addEventListener('click', () => this.selectBoard(b.id));
    return btn;
  }

  private projectAdder(): HTMLElement {
    if (!this.addingProject) return h('button', { class: 'ui-kb__adder', type: 'button', text: tr('+ novo projeto'), on: { click: () => ((this.addingProject = true), this.renderShelf()) } });
    return this.inlineInput(tr('Nome do projeto'), MAX_BOARD_NAME, (name) => void this.createProject(name), () => ((this.addingProject = false), this.renderShelf()));
  }

  private renderBoard(): void {
    setText(this.titleEl, this.board?.name ?? '');
    const visible = filterCards(this.cards, this.qTask);
    const groups = groupByColumn(visible);
    const searching = this.qTask.trim() !== '';
    const none = this.board !== undefined && !this.loading && this.cards.length === 0 && !searching;
    setText(this.emptyEl, searching && visible.length === 0 ? tr('Nenhuma tarefa encontrada neste quadro.') : none ? tr('Este quadro ainda não tem cartões. Use "+ post-it" em qualquer coluna.') : '');
    setHidden(this.emptyEl, !(searching && visible.length === 0) && !none);
    this.cols.replaceChildren(...COLUMNS.map((c) => this.column(c, groups[c])));
    if (this.addingCard) this.cols.querySelector<HTMLInputElement>('input')?.focus();
  }

  private column(column: Column, cards: KanbanCard[]): HTMLElement {
    const adder =
      this.addingCard === column
        ? this.inlineInput(tr('Título do cartão'), MAX_TITLE, (title) => void this.createCard(column, title), () => ((this.addingCard = null), this.renderBoard()))
        : h('button', { class: 'ui-kb__adder', type: 'button', text: tr('+ post-it'), on: { click: () => ((this.addingCard = column), this.renderBoard()) } });
    return h(
      'section',
      { class: `ui-kb__col ui-kb__col--${column}`, attrs: { 'aria-label': COLUMN_LABEL[column] } },
      h('header', { class: 'ui-kb__col-head' }, h('span', { text: COLUMN_LABEL[column] }), h('i', { text: String(cards.length) })),
      ...cards.map((c) => this.note(c)),
      adder,
    );
  }

  private note(c: KanbanCard): HTMLElement {
    const tag = c.projectId === null ? undefined : this.boards.find((b) => b.id === c.projectId)?.name;
    const meta = h(
      'div',
      { class: 'ui-kb__meta' },
      h('span', { class: `ui-kb__pri ui-kb__pri--${c.priority}`, text: PRIORITY_LABEL[c.priority] }),
      tag ? h('span', { class: 'ui-kb__badge ui-kb__badge--project', text: tag }) : null,
      c.createdVia === 'agent' ? h('span', { class: 'ui-kb__badge ui-kb__badge--agent', text: tr('via agente'), title: tr('Criado por um agente, a pedido do usuário') }) : null,
      c.assigneeName ? h('span', { class: 'ui-kb__who' }, h('span', { class: 'ui-kb__av', text: Array.from(c.assigneeName)[0]?.toUpperCase() ?? '?', attrs: { 'aria-hidden': 'true' } }), c.assigneeName) : null,
    );
    const note = h('div', { class: `ui-kb__note ui-kb__note--${TINTS[c.id % TINTS.length]}${c.id === this.selectedId ? ' is-selected' : ''}`, tabIndex: 0, role: 'button', attrs: { 'aria-pressed': c.id === this.selectedId } }, h('p', { class: 'ui-kb__note-title', text: c.title }), meta);
    const select = () => {
      this.selectedId = c.id === this.selectedId ? null : c.id;
      this.renderBoard();
    };
    note.addEventListener('click', select);
    note.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        select();
      }
    });
    return note;
  }

  /** Campo de uma linha: Enter confirma, Esc ou sair do campo vazio cancela. */
  private inlineInput(label: string, max: number, onSubmit: (text: string) => void, onCancel: () => void): HTMLElement {
    const input = h('input', { class: 'ui-kb__inline', type: 'text', attrs: { placeholder: label, 'aria-label': label, maxlength: max, autocomplete: 'off' } });
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      fn();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const value = input.value.trim();
        if (value) finish(() => onSubmit(value));
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(onCancel);
      }
    });
    input.addEventListener('blur', () => {
      if (!input.value.trim()) finish(onCancel);
    });
    return input;
  }
}
