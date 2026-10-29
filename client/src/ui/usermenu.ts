// Chip do usuário na barra do topo (avatar + nome) e o menu dele: Usuários, Trocar minha senha e Sair.
// Só existe quando o login está ligado (GET /api/me devolve um usuário): na porta local o chip fica escondido e o menu
// nem é montado visível.
import { tr } from '../../../shared/i18n';
import type { UserInfo } from '../../../shared/types';
import { fetchMe } from '../net/me';
import type { UiComponent } from './context';
import { h, setHidden, setText } from './dom';
import { avatar, OwnPasswordPanel, usersApi, UsersPanel } from './users';

export class UserMenu implements UiComponent {
  /** O botão do chip (escondido sem login). */
  readonly el: HTMLElement;
  /** Os painéis e o menu: ficam em `root`, fora da barra. */
  readonly panels: HTMLElement[];
  private me: UserInfo | null = null;
  private readonly menu: HTMLElement;
  private readonly menuHead: HTMLElement;
  private readonly users: UsersPanel;
  private readonly ownPassword = new OwnPasswordPanel();

  constructor() {
    this.users = new UsersPanel(
      () => this.me?.id ?? 0,
      () => void this.refresh(),
    );
    this.el = h('button', { class: 'ui-userchip', type: 'button', hidden: true, attrs: { 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': 'ui-usermenu' }, on: { click: () => this.toggleMenu() } });
    this.menuHead = h('div', { class: 'ui-usermenu__head' });
    const item = (label: string, onClick: () => void) => h('button', { class: 'ui-usermenu__item', type: 'button', role: 'menuitem', on: { click: onClick } }, label);
    this.menu = h(
      'div',
      { class: 'ui-popover ui-usermenu', role: 'menu', tabIndex: -1, attrs: { id: 'ui-usermenu', popover: 'auto', 'aria-label': tr('Menu do usuário') } },
      this.menuHead,
      item(tr('Usuários'), () => this.go(() => this.users.open(this.el))),
      item(tr('Trocar minha senha'), () => this.go(() => this.ownPassword.open(this.el))),
      h('hr', { class: 'ui-usermenu__sep' }),
      item(tr('Sair'), () => void this.logout()),
    );
    this.menu.addEventListener('toggle', () => this.el.setAttribute('aria-expanded', String(this.menuOpen)));
    this.panels = [this.menu, this.users.el, this.ownPassword.el];
    void this.refresh();
  }

  render(): void {
    // Nada a reconciliar por quadro: o chip só muda quando o perfil é buscado de novo.
  }

  private get menuOpen(): boolean {
    try {
      return this.menu.matches(':popover-open');
    } catch {
      return this.menu.classList.contains('is-open');
    }
  }

  /** Busca quem está logado e (re)pinta o chip; sem usuário (porta local, erro de rede) ele some. */
  async refresh(): Promise<void> {
    this.me = await fetchMe();
    const me = this.me;
    setHidden(this.el, !me);
    if (!me) {
      this.el.replaceChildren();
      return;
    }
    const name = h('span', { class: 'ui-userchip__name', text: me.displayName });
    this.el.replaceChildren(avatar(me), name);
    this.el.title = tr('Entrou como {0}', [me.displayName]);
    setText(this.menuHead, tr('Entrou como {0}', [me.displayName]));
  }

  private toggleMenu(): void {
    if (this.menuOpen) return this.closeMenu();
    const r = this.el.getBoundingClientRect();
    this.menu.style.top = `${Math.round(r.bottom + 8)}px`;
    this.menu.style.right = `${Math.max(8, Math.round(innerWidth - r.right - 4))}px`;
    if (typeof this.menu.showPopover === 'function') this.menu.showPopover();
    else this.menu.classList.add('is-open');
    this.el.setAttribute('aria-expanded', 'true');
  }

  private closeMenu(): void {
    if (typeof this.menu.hidePopover === 'function' && this.menuOpen) this.menu.hidePopover();
    this.menu.classList.remove('is-open');
    this.el.setAttribute('aria-expanded', 'false');
  }

  private go(open: () => void): void {
    this.closeMenu();
    open();
  }

  private async logout(): Promise<void> {
    this.closeMenu();
    try {
      await usersApi('/api/remote/logout', { method: 'POST', body: {} });
    } catch {
      // mesmo sem resposta, volta ao login: lá se vê se a sessão ainda vale
    }
    location.replace('/login');
  }
}
