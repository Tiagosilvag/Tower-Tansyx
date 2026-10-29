// Kanban do time: o quadro branco da parede da sala, com uma estante de projetos ao lado (retrátil) e post-its nas colunas.
// Dados de /api/kanban/* (net/kanban.ts). Tudo que o usuário escreve entra como texto (h/setText), nunca como HTML.
// Quadros e cartões, as duas buscas, criar projeto e cartão, arrastar (mouse) e mover pelo teclado (Alt+setas). Abrir um cartão: ui/kanban-card.ts.
import { tr } from '../../../shared/i18n';
import { COLUMNS, MAX_BOARD_NAME, MAX_TITLE, type Column, type KanbanBoard, type KanbanCard } from '../../../shared/kanban';
import { kanbanApi } from '../net/kanban';
import type { UiComponent, UiContext } from './context';
import { h, iconButton, setHidden, setText } from './dom';
import { ICONS } from './icons';
import { CardDialog } from './kanban-card';
import { applyMove, COLUMN_LABEL, dropTarget, filterBoards, filterCards, groupByColumn, loadShelf, PRIORITY_LABEL, saveShelf, type ShelfState } from './kanban-model';

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
  private dragId: number | null = null;
  /** Texto que o usuário tinha digitado quando o servidor recusou: o campo reaparece com ele. */
  private draft = '';
  private renaming = false;
  private confirmingDelete = false;
  private readonly cardDialog: CardDialog;
  private opener: HTMLElement | null = null;

  private readonly shelfEl: HTMLElement;
  private readonly shelfList: HTMLElement;
  private readonly fold: HTMLButtonElement;
  private readonly titleEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly statusText: HTMLElement;
  private readonly retry: HTMLButtonElement;
  private readonly emptyEl: HTMLElement;
  private readonly actionsEl: HTMLElement;
  private readonly confirmEl: HTMLElement;
  private readonly cols: HTMLElement;
  private readonly searchTask: HTMLInputElement;
  private readonly searchProj: HTMLInputElement;

  /** `button` = o botão do Kanban na barra superior (ui/kanban-launcher.ts), que reflete se a janela está aberta. */
  constructor(
    private readonly ctx: UiContext,
    private readonly button: HTMLElement,
  ) {
    this.cardDialog = new CardDialog({ boards: () => this.boards, changed: () => void this.refresh() });
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
    this.confirmEl = h('div', { class: 'ui-kb__confirm', role: 'alert', hidden: true });
    this.actionsEl = h(
      'span',
      { class: 'ui-kb__actions', hidden: true },
      h('button', { class: 'ui-kb__link', type: 'button', text: tr('Renomear'), on: { click: () => ((this.renaming = true), this.renderBoard()) } }),
      h('button', { class: 'ui-kb__link ui-kb__link--danger', type: 'button', text: tr('Excluir projeto'), on: { click: () => ((this.confirmingDelete = true), this.renderBoard()) } }),
    );
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
            this.actionsEl,
            h('label', { class: 'ui-kb__search' }, h('span', { text: '⌕', attrs: { 'aria-hidden': 'true' } }), this.searchTask),
            close,
          ),
          h('div', { class: 'ui-kb__layout' }, this.shelfEl, h('div', { class: 'ui-kb__main' }, this.statusEl, this.confirmEl, this.emptyEl, this.cols)),
        ),
      ),
      this.cardDialog.el,
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
    this.renaming = false;
    this.confirmingDelete = false;
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
      // O campo some quando confirma; volta, com o que foi digitado, para a pessoa corrigir (e o erro aparece acima).
      this.draft = title;
      this.say((err as Error).message);
      this.renderBoard();
    }
  }

  private async createProject(name: string): Promise<void> {
    try {
      const board = await kanbanApi.createBoard(name);
      this.addingProject = false;
      this.boards = [...this.boards, board];
      this.selectBoard(board.id);
    } catch (err) {
      this.draft = name;
      this.say((err as Error).message);
      this.renderShelf();
    }
  }

  private async renameBoard(name: string): Promise<void> {
    if (this.boardId === null) return;
    try {
      await kanbanApi.renameBoard(this.boardId, name);
      this.renaming = false;
      await this.refresh();
    } catch (err) {
      this.draft = name;
      this.say((err as Error).message);
      this.renderBoard();
    }
  }

  /** Apaga o projeto aberto (com os cartões, se houver: a confirmação já avisou) e volta para o Geral. */
  private async deleteProject(): Promise<void> {
    const board = this.board;
    if (!board || board.kind !== 'project') return;
    try {
      await kanbanApi.deleteBoard(board.id, this.cards.length > 0);
      this.confirmingDelete = false;
      this.boardId = null;
      this.shelf = { ...this.shelf, boardId: null };
      saveShelf(this.shelf);
      await this.load();
    } catch (err) {
      this.confirmingDelete = false;
      this.say((err as Error).message);
      this.renderBoard();
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
    const board = this.board;
    const project = board?.kind === 'project';
    if (!project) {
      this.renaming = false;
      this.confirmingDelete = false;
    }
    if (this.renaming && board) {
      this.titleEl.replaceChildren(this.inlineInput(tr('Novo nome do projeto'), MAX_BOARD_NAME, (name) => void this.renameBoard(name), () => ((this.renaming = false), this.renderBoard()), board.name));
      this.titleEl.querySelector<HTMLInputElement>('input')?.focus();
    } else setText(this.titleEl, board?.name ?? '');
    setHidden(this.actionsEl, !project || this.renaming);
    this.renderConfirm(board);
    const visible = filterCards(this.cards, this.qTask);
    const groups = groupByColumn(visible);
    const searching = this.qTask.trim() !== '';
    const none = this.board !== undefined && !this.loading && this.cards.length === 0 && !searching;
    setText(this.emptyEl, searching && visible.length === 0 ? tr('Nenhuma tarefa encontrada neste quadro.') : none ? tr('Este quadro ainda não tem cartões. Use "+ post-it" em qualquer coluna.') : '');
    setHidden(this.emptyEl, !(searching && visible.length === 0) && !none);
    this.cols.replaceChildren(...COLUMNS.map((c) => this.column(c, groups[c])));
    if (this.addingCard) this.cols.querySelector<HTMLInputElement>('input')?.focus();
  }

  /** Excluir projeto pede confirmação aqui mesmo (sem o confirm() do navegador) e diz quantos cartões vão junto. */
  private renderConfirm(board: KanbanBoard | undefined): void {
    const show = this.confirmingDelete && board?.kind === 'project';
    setHidden(this.confirmEl, !show);
    if (!show || !board) return this.confirmEl.replaceChildren();
    const n = this.cards.length;
    this.confirmEl.replaceChildren(
      h('span', {
        text: n === 0 ? tr('Excluir o projeto "{0}"?', [board.name]) : n === 1 ? tr('Excluir o projeto "{0}"? O cartão dele também será apagado.', [board.name]) : tr('Excluir o projeto "{0}"? Os {1} cartões dele também serão apagados.', [board.name, n]),
      }),
      h('button', { class: 'ui-kb__btn ui-kb__btn--danger', type: 'button', text: tr('Excluir'), on: { click: () => void this.deleteProject() } }),
      h('button', { class: 'ui-kb__btn', type: 'button', text: tr('Cancelar'), on: { click: () => ((this.confirmingDelete = false), this.renderBoard()) } }),
    );
  }

  private column(column: Column, cards: KanbanCard[]): HTMLElement {
    const adder =
      this.addingCard === column
        ? this.inlineInput(tr('Título do cartão'), MAX_TITLE, (title) => void this.createCard(column, title), () => ((this.addingCard = null), this.renderBoard()))
        : h('button', { class: 'ui-kb__adder', type: 'button', text: tr('+ post-it'), on: { click: () => ((this.addingCard = column), this.renderBoard()) } });
    const section = h(
      'section',
      { class: `ui-kb__col ui-kb__col--${column}`, attrs: { 'aria-label': COLUMN_LABEL[column] } },
      h('header', { class: 'ui-kb__col-head' }, h('span', { text: COLUMN_LABEL[column] }), h('i', { text: String(cards.length) })),
      ...cards.map((c) => this.note(c)),
      adder,
    );
    this.wireDrop(section, column);
    return section;
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
    // Com a busca ligada a lista na tela não é a coluna inteira: o arrasto fica desligado (o índice de soltar mentiria).
    const draggable = this.qTask.trim() === '';
    const note = h(
      'div',
      { class: `ui-kb__note ui-kb__note--${TINTS[c.id % TINTS.length]}`, tabIndex: 0, role: 'button', attrs: { 'data-id': c.id, draggable: draggable ? 'true' : undefined, 'aria-keyshortcuts': 'Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown' } },
      h('p', { class: 'ui-kb__note-title', text: c.title }),
      meta,
    );
    note.addEventListener('click', () => void this.cardDialog.open(c.id, note));
    note.addEventListener('keydown', (e) => this.noteKey(e, c, note));
    note.addEventListener('dragstart', (e) => {
      this.dragId = c.id;
      e.dataTransfer?.setData('text/plain', String(c.id));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      note.classList.add('is-dragging');
    });
    note.addEventListener('dragend', () => {
      this.dragId = null;
      this.clearDrop();
      note.classList.remove('is-dragging');
    });
    return note;
  }

  /** Enter ou espaço abrem; Alt+setas movem sem arrastar (esquerda e direita trocam de coluna, cima e baixo reordenam). */
  private noteKey(e: KeyboardEvent, c: KanbanCard, note: HTMLElement): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      void this.cardDialog.open(c.id, note);
      return;
    }
    if (!e.altKey) return;
    const idx = COLUMNS.indexOf(c.column);
    let to: { column: Column; position: number } | null = null;
    if (e.key === 'ArrowLeft' && idx > 0) to = { column: COLUMNS[idx - 1]!, position: Number.MAX_SAFE_INTEGER };
    else if (e.key === 'ArrowRight' && idx < COLUMNS.length - 1) to = { column: COLUMNS[idx + 1]!, position: Number.MAX_SAFE_INTEGER };
    else if (e.key === 'ArrowUp' && c.position > 0 && this.qTask.trim() === '') to = { column: c.column, position: c.position - 1 };
    else if (e.key === 'ArrowDown' && this.qTask.trim() === '') to = { column: c.column, position: c.position + 1 };
    if (!to) return;
    e.preventDefault();
    void this.move(c.id, to.column, to.position).then(() => this.cols.querySelector<HTMLElement>(`[data-id="${c.id}"]`)?.focus());
    this.ctx.announce(tr('Movido para {0}', [COLUMN_LABEL[to.column]]));
  }

  /** Move na tela na hora e confirma no servidor; se o servidor recusar, a tela volta ao que ele tem. */
  private async move(id: number, column: Column, position: number): Promise<void> {
    this.cards = applyMove(this.cards, id, column, position);
    this.renderBoard();
    try {
      const target = this.cards.find((c) => c.id === id);
      await kanbanApi.moveCard(id, { column, position: target?.position ?? position });
      await this.refresh();
    } catch (err) {
      this.say((err as Error).message);
      await this.refresh();
    }
  }

  // ---------------------------------------------------------------- arrastar

  private clearDrop(): void {
    this.cols.querySelectorAll('.is-drop-before, .is-drop-end, .is-drop').forEach((el) => el.classList.remove('is-drop-before', 'is-drop-end', 'is-drop'));
  }

  /** Índice de soltar numa coluna: antes do primeiro cartão cujo meio está abaixo do ponteiro (n = no fim). */
  private dropIndex(col: HTMLElement, clientY: number): number {
    const notes = [...col.querySelectorAll<HTMLElement>('.ui-kb__note')];
    const i = notes.findIndex((n) => clientY < n.getBoundingClientRect().top + n.getBoundingClientRect().height / 2);
    return i === -1 ? notes.length : i;
  }

  private wireDrop(col: HTMLElement, column: Column): void {
    col.addEventListener('dragover', (e) => {
      if (this.dragId === null) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      this.clearDrop();
      col.classList.add('is-drop');
      const notes = col.querySelectorAll<HTMLElement>('.ui-kb__note');
      const i = this.dropIndex(col, e.clientY);
      if (i < notes.length) notes[i]!.classList.add('is-drop-before');
      else col.classList.add('is-drop-end');
    });
    col.addEventListener('drop', (e) => {
      if (this.dragId === null) return;
      e.preventDefault();
      const id = this.dragId;
      const t = dropTarget(this.cards, id, column, this.dropIndex(col, e.clientY));
      this.dragId = null;
      this.clearDrop();
      void this.move(id, t.column, t.position);
    });
  }

  /** Campo de uma linha: Enter confirma, Esc ou sair do campo vazio cancela. */
  private inlineInput(label: string, max: number, onSubmit: (text: string) => void, onCancel: () => void, initial = ''): HTMLElement {
    const input = h('input', { class: 'ui-kb__inline', type: 'text', attrs: { placeholder: label, 'aria-label': label, maxlength: max, autocomplete: 'off' } });
    input.value = initial || this.draft;
    this.draft = '';
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
