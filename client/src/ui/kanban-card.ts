// Cartão aberto do Kanban: edição dos campos, mover de coluna e de quadro, comentário, histórico (com a marca "via agente")
// e exclusão. Um <dialog> modal dentro do painel (ui/kanban.ts), que recarrega o quadro quando algo muda.
// Tudo que vem do servidor entra como texto (h/setText), nunca como HTML.
import { tr } from '../../../shared/i18n';
import { COLUMNS, MAX_COMMENT, MAX_DESCRIPTION, MAX_TITLE, PRIORITIES, type Column, type KanbanBoard, type KanbanCard, type KanbanEvent, type Priority } from '../../../shared/kanban';
import type { UserInfo } from '../../../shared/types';
import { kanbanApi, type CardPatch } from '../net/kanban';
import { h, iconButton, setText } from './dom';
import { ICONS } from './icons';
import { COLUMN_LABEL, describeEvent, PRIORITY_LABEL } from './kanban-model';
import { usersApi } from './users';

export interface CardHost {
  boards(): KanbanBoard[];
  /** O cartão mudou de lugar ou de conteúdo: o quadro recarrega. */
  changed(): void;
}

const option = (value: string, label: string, selected: boolean): HTMLOptionElement => {
  const o = h('option', { text: label });
  o.value = value;
  o.selected = selected;
  return o;
};

export class CardDialog {
  readonly el: HTMLDialogElement;
  private card: KanbanCard | null = null;
  private events: KanbanEvent[] = [];
  private users: UserInfo[] | null = null;
  private confirming = false;
  private opener: HTMLElement | null = null;
  private readonly body = h('div', { class: 'ui-kbc__body' });
  private readonly status = h('p', { class: 'ui-kbc__status', attrs: { role: 'status', 'aria-live': 'polite' }, hidden: true });

  constructor(private readonly host: CardHost) {
    const close = iconButton(ICONS.close, tr('Fechar (Esc)'), () => this.close(), 'ui-icon-btn--sm');
    this.el = h('dialog', { class: 'ui-dialog ui-kbc', attrs: { 'aria-label': tr('Cartão') } }, h('div', { class: 'ui-kbc__head' }, h('span', { class: 'ui-kbc__tag' }), close), this.status, this.body);
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.close();
    });
    this.el.addEventListener('keydown', (e) => e.stopPropagation());
    this.el.addEventListener('close', () => {
      this.card = null;
      if (this.opener?.isConnected) this.opener.focus({ preventScroll: true });
      this.opener = null;
    });
  }

  async open(id: number, opener: HTMLElement | null): Promise<void> {
    this.opener = opener;
    this.confirming = false;
    this.say('');
    this.body.replaceChildren();
    if (!this.el.open) this.el.showModal();
    this.users ??= await usersApi<{ users: UserInfo[] }>('/api/users').then(
      (r) => r.users,
      () => [], // sem login ou fora do modo de usuários: sem lista de responsáveis
    );
    await this.reload(id);
  }

  close(): void {
    if (this.el.open) this.el.close();
  }

  private say(message: string): void {
    setText(this.status, message);
    this.status.hidden = !message;
  }

  private async reload(id: number): Promise<void> {
    try {
      const r = await kanbanApi.card(id);
      this.card = r.card;
      this.events = r.events;
      this.render();
    } catch (err) {
      this.say((err as Error).message);
    }
  }

  /** Salva uma mudança, recarrega o cartão (e o histórico) e avisa o quadro; erro volta os campos ao que o servidor tem. */
  private async save(action: () => Promise<unknown>): Promise<void> {
    const id = this.card?.id;
    if (id === undefined) return;
    this.say('');
    try {
      await action();
      this.host.changed();
    } catch (err) {
      this.say((err as Error).message);
    }
    await this.reload(id);
  }

  private patch(p: CardPatch): Promise<void> {
    return this.save(() => kanbanApi.updateCard(this.card!.id, p));
  }

  private render(): void {
    const c = this.card;
    if (!c) return;
    const boards = this.host.boards();
    const board = boards.find((b) => b.id === c.boardId);
    setText(this.el.querySelector('.ui-kbc__tag')!, `${board?.name ?? ''} · ${COLUMN_LABEL[c.column]}`);

    const title = h('input', { class: 'ui-kbc__title', type: 'text', attrs: { maxlength: MAX_TITLE, 'aria-label': tr('Título') } });
    title.value = c.title;
    title.addEventListener('change', () => void this.patch({ title: title.value }));
    const description = h('textarea', { class: 'ui-kbc__desc', attrs: { maxlength: MAX_DESCRIPTION, rows: 4, 'aria-label': tr('Descrição'), placeholder: tr('Descrição (opcional)') } });
    description.value = c.description;
    description.addEventListener('change', () => void this.patch({ description: description.value }));

    const priority = h('select', { class: 'ui-kbc__select', attrs: { 'aria-label': tr('Prioridade') } }, ...PRIORITIES.map((p) => option(p, PRIORITY_LABEL[p], p === c.priority)));
    priority.addEventListener('change', () => void this.patch({ priority: priority.value as Priority }));
    const column = h('select', { class: 'ui-kbc__select', attrs: { 'aria-label': tr('Coluna') } }, ...COLUMNS.map((k) => option(k, COLUMN_LABEL[k], k === c.column)));
    column.addEventListener('change', () => void this.save(() => kanbanApi.moveCard(c.id, { column: column.value as Column })));

    const rows: Array<[string, Node]> = [
      [tr('Prioridade'), priority],
      [tr('Coluna'), column],
    ];
    const people = this.users ?? [];
    if (people.length) {
      const who = h('select', { class: 'ui-kbc__select', attrs: { 'aria-label': tr('Responsável') } }, option('', tr('Sem responsável'), c.assigneeId === null), ...people.map((u) => option(String(u.id), u.displayName || u.username, u.id === c.assigneeId)));
      who.addEventListener('change', () => void this.patch({ assigneeId: who.value ? Number(who.value) : null }));
      rows.push([tr('Responsável'), who]);
    } else if (c.assigneeName) rows.push([tr('Responsável'), h('span', { text: c.assigneeDisplayName || c.assigneeName })]);

    const projects = boards.filter((b) => b.kind === 'project');
    if (board?.kind === 'general' && projects.length) {
      const tag = h('select', { class: 'ui-kbc__select', attrs: { 'aria-label': tr('Projeto') } }, option('', tr('Nenhum'), c.projectId === null), ...projects.map((b) => option(String(b.id), b.name, b.id === c.projectId)));
      tag.addEventListener('change', () => void this.patch({ projectId: tag.value ? Number(tag.value) : null }));
      rows.push([tr('Projeto'), h('span', { class: 'ui-kbc__stack' }, tag, h('small', { text: tr('Só uma etiqueta: o cartão continua no Geral.') }))]);
    }
    rows.push([tr('Criado por'), h('span', { class: 'ui-kbc__by' }, c.createdByName ?? '—', c.createdVia === 'agent' ? h('span', { class: 'ui-kb__badge ui-kb__badge--agent', text: tr('via agente') }) : null, h('small', { text: new Date(c.createdAt).toLocaleString() }))]);

    const others = boards.filter((b) => b.id !== c.boardId);
    let mover: HTMLElement | null = null;
    if (others.length) {
      const select = h('select', { class: 'ui-kbc__select', attrs: { 'aria-label': tr('Mover para o quadro') } }, option('', tr('Mover para o quadro…'), true), ...others.map((b) => option(String(b.id), b.name, false)));
      select.addEventListener('change', () => {
        if (!select.value) return;
        const to = Number(select.value);
        void this.save(() => kanbanApi.moveCard(c.id, { boardId: to })).then(() => this.close());
      });
      mover = h('div', { class: 'ui-kbc__move' }, select);
    }

    const comment = h('textarea', { class: 'ui-kbc__desc', attrs: { maxlength: MAX_COMMENT, rows: 2, 'aria-label': tr('Comentário'), placeholder: tr('Escrever um comentário…') } });
    const send = h('button', { class: 'ui-kbc__btn', type: 'button', text: tr('Comentar'), on: { click: () => comment.value.trim() && void this.save(() => kanbanApi.comment(c.id, comment.value)) } });

    this.body.replaceChildren(
      title,
      description,
      h('dl', { class: 'ui-kbc__fields' }, ...rows.flatMap(([label, node]) => [h('dt', { text: label }), h('dd', {}, node)])),
      ...(mover ? [mover] : []),
      h('div', { class: 'ui-kbc__comment' }, comment, send),
      h('h3', { class: 'ui-kbc__h', text: tr('Histórico') }),
      h('ul', { class: 'ui-kbc__log' }, ...this.events.map((e) => this.eventRow(e))),
      this.danger(c),
    );
  }

  private eventRow(e: KanbanEvent): HTMLElement {
    const { text, quote } = describeEvent(e);
    const who = e.actorName ?? (e.via === 'agent' ? tr('agente') : tr('alguém'));
    return h(
      'li',
      {},
      h('b', { text: who }),
      ' ',
      e.via === 'agent' ? h('span', { class: 'ui-kb__badge ui-kb__badge--agent', text: tr('via agente') }) : null,
      ` ${text}`,
      h('small', { text: ` · ${new Date(e.at).toLocaleString()}` }),
      quote ? h('blockquote', { class: 'ui-kbc__quote', text: quote }) : null,
    );
  }

  /** Excluir pede confirmação aqui mesmo, sem o confirm() do navegador. */
  private danger(c: KanbanCard): HTMLElement {
    if (!this.confirming) return h('button', { class: 'ui-kbc__link', type: 'button', text: tr('Excluir cartão'), on: { click: () => ((this.confirming = true), this.render()) } });
    return h(
      'div',
      { class: 'ui-kbc__confirm', role: 'alert' },
      h('span', { text: tr('Excluir este cartão e o histórico dele?') }),
      h('button', { class: 'ui-kbc__btn ui-kbc__btn--danger', type: 'button', text: tr('Excluir'), on: { click: () => void this.save(() => kanbanApi.deleteCard(c.id)).then(() => this.close()) } }),
      h('button', { class: 'ui-kbc__btn', type: 'button', text: tr('Cancelar'), on: { click: () => ((this.confirming = false), this.render()) } }),
    );
  }
}
