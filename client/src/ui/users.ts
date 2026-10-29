// Administração de usuários (menu do chip, ui/usermenu.ts): a lista de contas, o cadastro, a troca de senha de cada uma
// (/api/users, /api/users/:id/password) e a troca da própria senha (/api/me/password). Todos os usuários têm o mesmo
// acesso. Senhas só existem nos campos do formulário: são limpas ao enviar e nunca guardadas nem registradas.
import { tr } from '../../../shared/i18n';
import type { UserInfo } from '../../../shared/types';
import { h, iconButton, setText } from './dom';
import { ICONS } from './icons';
import { initialOf, passwordProblem, userRowLabel } from './users-model';

/** Pedido JSON à API de usuários. Erros do servidor (já traduzidos) viram `Error`; 401 leva ao login. */
export async function usersApi<T = void>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      ...(init.body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) } : {}),
    });
  } catch {
    throw new Error(tr('o Habblaud não respondeu'));
  }
  if (res.status === 401) {
    location.replace('/login');
    throw new Error(tr('Sessão encerrada.'));
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error ?? tr('erro {0}', [res.status]));
  return body as T;
}

/** Avatar redondo com a cor do usuário e a inicial do nome (texto escuro). */
export function avatar(user: Pick<UserInfo, 'color' | 'displayName'>, extraClass = ''): HTMLElement {
  return h('span', { class: `ui-avatar ${extraClass}`.trim(), style: `background:${/^#[0-9a-fA-F]{6}$/.test(user.color) ? user.color : '#7cc8ff'}`, text: initialOf(user.displayName), attrs: { 'aria-hidden': 'true' } });
}

/** Base dos dois painéis: popover com cabeçalho, linha de estado e posição junto ao botão que abriu. */
abstract class Panel {
  readonly el: HTMLElement;
  protected readonly body: HTMLElement;
  protected readonly status: HTMLElement;
  protected busy = false;
  private anchor?: HTMLElement;

  constructor(id: string, title: string) {
    this.status = h('p', { class: 'ui-rename__hint ui-spawn__status', attrs: { role: 'status', 'aria-live': 'polite' } });
    this.body = h('div', { class: 'ui-set-group ui-users__body' });
    const close = iconButton(ICONS.close, tr('Fechar'), () => this.hide(), 'ui-icon-btn--sm');
    this.el = h('div', { class: 'ui-popover ui-users', role: 'dialog', tabIndex: -1, attrs: { 'aria-label': title, id, popover: 'auto' } }, h('div', { class: 'ui-popover__head' }, h('h2', { text: title }), close), this.body);
    this.el.addEventListener('keydown', (e) => e.stopPropagation());
    this.el.addEventListener('keyup', (e) => e.stopPropagation());
  }

  get isOpen(): boolean {
    try {
      return this.el.matches(':popover-open');
    } catch {
      return this.el.classList.contains('is-open');
    }
  }

  protected abstract onOpen(): void;

  open(anchor: HTMLElement): void {
    this.anchor = anchor;
    this.say('');
    this.onOpen();
    const r = anchor.getBoundingClientRect();
    this.el.style.top = `${Math.round(r.bottom + 8)}px`;
    this.el.style.right = `${Math.max(8, Math.round(innerWidth - r.right - 4))}px`;
    if (typeof this.el.showPopover === 'function') this.el.showPopover();
    else this.el.classList.add('is-open');
  }

  hide(): void {
    if (typeof this.el.hidePopover === 'function' && this.isOpen) this.el.hidePopover();
    this.el.classList.remove('is-open');
    this.anchor?.focus?.();
  }

  protected say(text: string, error = false): void {
    setText(this.status, text);
    this.status.classList.toggle('is-error', error);
  }

  protected field(id: string, label: string, type: 'text' | 'password', autocomplete: string, extra: { maxlength?: number } = {}): { wrap: HTMLElement; input: HTMLInputElement } {
    const input = h('input', {
      class: 'ui-rename__input',
      type,
      attrs: { id, name: id, autocomplete, spellcheck: 'false', autocapitalize: 'none', ...(extra.maxlength ? { maxlength: extra.maxlength } : {}) },
    });
    return { wrap: h('div', { class: 'ui-users__field' }, h('label', { class: 'ui-spawn__label', attrs: { for: id }, text: label }), input), input };
  }
}

/** Painel "Usuários": lista, troca de senha por usuário, remoção em dois toques e cadastro. */
export class UsersPanel extends Panel {
  private users: UserInfo[] = [];
  private readonly list: HTMLElement;
  private readonly form: { user: HTMLInputElement; name: HTMLInputElement; pass: HTMLInputElement; submit: HTMLButtonElement };
  /** Usuário cuja linha mostra o campo de nova senha / o pedido de confirmação de remoção. */
  private editing: number | null = null;
  private removing: number | null = null;

  constructor(
    private readonly meId: () => number,
    /** Algo que pode ter mudado o próprio perfil (nome, lista): o chip busca de novo. */
    private readonly onChange: () => void,
  ) {
    super('ui-users-panel', tr('Usuários'));
    this.list = h('ul', { class: 'ui-users__list', attrs: { 'aria-label': tr('Usuários') } });
    const user = this.field('ui-users-new-username', tr('Usuário'), 'text', 'off', { maxlength: 32 });
    const name = this.field('ui-users-new-name', tr('Nome na tela'), 'text', 'off', { maxlength: 40 });
    const pass = this.field('ui-users-new-password', tr('Senha inicial'), 'password', 'new-password');
    const submit = h('button', { class: 'ui-btn ui-perm__btn ui-perm__btn--allow ui-users__create', type: 'button', on: { click: () => void this.create() } }, tr('Criar usuário'));
    this.form = { user: user.input, name: name.input, pass: pass.input, submit };
    for (const input of [user.input, name.input, pass.input]) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          void this.create();
        }
      });
    }
    this.body.append(this.list, h('div', { class: 'ui-users__new' }, user.wrap, name.wrap, pass.wrap, submit), this.status, h('p', { class: 'ui-rename__hint', text: tr('Todos os usuários têm o mesmo acesso e podem administrar as contas.') }));
  }

  protected onOpen(): void {
    this.editing = null;
    this.removing = null;
    this.renderList();
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      this.users = (await usersApi<{ users: UserInfo[] }>('/api/users')).users;
      this.renderList();
    } catch (err) {
      this.say((err as Error).message, true);
    }
  }

  private renderList(): void {
    const now = Date.now();
    const me = this.meId();
    this.list.replaceChildren(...this.users.map((u) => this.row(u, now, me)));
  }

  private row(u: UserInfo, now: number, me: number): HTMLElement {
    const label = userRowLabel(u, now, me);
    const actions = h('div', { class: 'ui-users__actions' });
    actions.append(
      h('button', { class: 'ui-btn', type: 'button', on: { click: () => this.toggleEdit(u.id) } }, tr('Trocar senha')),
    );
    if (!label.isMe) {
      const confirming = this.removing === u.id;
      actions.append(
        h(
          'button',
          { class: `ui-btn ui-perm__btn--deny${confirming ? ' is-on' : ''}`, type: 'button', on: { click: () => (confirming ? void this.remove(u) : this.askRemove(u.id)) } },
          confirming ? tr('Confirmar remoção') : tr('Remover'),
        ),
      );
    }
    const li = h(
      'li',
      { class: 'ui-users__row' },
      h(
        'div',
        { class: 'ui-users__line' },
        avatar(u),
        h('div', { class: 'ui-users__who' }, h('div', { class: 'ui-users__name' }, h('b', { text: label.name }), label.isMe ? h('span', { class: 'ui-users__me', text: tr('você') }) : null), h('div', { class: 'ui-users__detail', text: label.detail })),
      ),
      actions,
    );
    if (this.editing === u.id) li.append(this.passwordForm(u));
    return li;
  }

  private toggleEdit(id: number): void {
    this.editing = this.editing === id ? null : id;
    this.removing = null;
    this.say('');
    this.renderList();
  }

  private askRemove(id: number): void {
    this.removing = id;
    this.editing = null;
    this.say('');
    this.renderList();
  }

  private passwordForm(u: UserInfo): HTMLElement {
    const a = this.field(`ui-users-pw-${u.id}`, tr('Nova senha'), 'password', 'new-password');
    const b = this.field(`ui-users-pw2-${u.id}`, tr('Repita a nova senha'), 'password', 'new-password');
    const go = async () => {
      if (this.busy) return;
      const problem = passwordProblem(a.input.value, b.input.value);
      if (problem) return this.say(problem, true);
      this.busy = true;
      const password = a.input.value;
      a.input.value = '';
      b.input.value = '';
      try {
        await usersApi(`/api/users/${u.id}/password`, { method: 'POST', body: { password } });
        this.editing = null;
        this.renderList();
        this.say(tr('Senha de {0} trocada.', [u.displayName]));
      } catch (err) {
        this.say((err as Error).message, true);
      } finally {
        this.busy = false;
      }
    };
    for (const input of [a.input, b.input]) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          void go();
        }
      });
    }
    return h('div', { class: 'ui-users__edit' }, a.wrap, b.wrap, h('button', { class: 'ui-btn ui-perm__btn ui-perm__btn--allow', type: 'button', on: { click: () => void go() } }, tr('Salvar senha')));
  }

  private async remove(u: UserInfo): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await usersApi(`/api/users/${u.id}`, { method: 'DELETE' });
      this.removing = null;
      this.users = this.users.filter((x) => x.id !== u.id);
      this.renderList();
      this.say(tr('Usuário {0} removido.', [u.username]));
      this.onChange();
    } catch (err) {
      this.removing = null;
      this.renderList();
      this.say((err as Error).message, true);
    } finally {
      this.busy = false;
    }
  }

  private async create(): Promise<void> {
    if (this.busy) return;
    const { user, name, pass, submit } = this.form;
    const username = user.value.trim();
    if (!username) return this.say(tr('Informe o usuário.'), true);
    const problem = passwordProblem(pass.value, pass.value);
    if (problem) return this.say(problem, true);
    this.busy = true;
    submit.disabled = true;
    const password = pass.value;
    pass.value = '';
    try {
      const displayName = name.value.trim();
      const created = await usersApi<UserInfo>('/api/users', { method: 'POST', body: { username, ...(displayName ? { displayName } : {}), password } });
      user.value = '';
      name.value = '';
      this.users = [...this.users, created];
      this.renderList();
      this.say(tr('Usuário {0} criado.', [created.username]));
      this.onChange();
    } catch (err) {
      this.say((err as Error).message, true);
    } finally {
      this.busy = false;
      submit.disabled = false;
    }
  }
}

/** Janelinha "Trocar minha senha": senha atual, nova e confirmação. */
export class OwnPasswordPanel extends Panel {
  private readonly current: HTMLInputElement;
  private readonly next: HTMLInputElement;
  private readonly again: HTMLInputElement;
  private readonly submit: HTMLButtonElement;

  constructor() {
    super('ui-users-own', tr('Trocar minha senha'));
    const cur = this.field('ui-own-current', tr('Senha atual'), 'password', 'current-password');
    const nxt = this.field('ui-own-new', tr('Nova senha'), 'password', 'new-password');
    const rep = this.field('ui-own-confirm', tr('Repita a nova senha'), 'password', 'new-password');
    this.current = cur.input;
    this.next = nxt.input;
    this.again = rep.input;
    this.submit = h('button', { class: 'ui-btn ui-perm__btn ui-perm__btn--allow ui-users__create', type: 'button', on: { click: () => void this.save() } }, tr('Trocar senha'));
    for (const input of [this.current, this.next, this.again]) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          void this.save();
        }
      });
    }
    this.body.append(cur.wrap, nxt.wrap, rep.wrap, this.submit, this.status);
  }

  protected onOpen(): void {
    this.clear();
  }

  private clear(): void {
    this.current.value = '';
    this.next.value = '';
    this.again.value = '';
  }

  private async save(): Promise<void> {
    if (this.busy) return;
    if (!this.current.value) return this.say(tr('Informe a senha atual.'), true);
    const problem = passwordProblem(this.next.value, this.again.value);
    if (problem) return this.say(problem, true);
    this.busy = true;
    this.submit.disabled = true;
    const body = { currentPassword: this.current.value, password: this.next.value };
    this.clear();
    try {
      await usersApi('/api/me/password', { method: 'POST', body });
      this.say(tr('Senha trocada.'));
    } catch (err) {
      this.say((err as Error).message, true);
    } finally {
      this.busy = false;
      this.submit.disabled = false;
    }
  }
}
