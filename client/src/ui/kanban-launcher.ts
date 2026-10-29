// Botão "Kanban" da barra superior. O painel (ui/kanban.ts) fica num pedaço separado do bundle e só é baixado na primeira
// abertura, como o "Meu dia" (ui/daystats-launcher.ts).
import { tr } from '../../../shared/i18n';
import type { UiComponent, UiContext } from './context';
import { iconButton } from './dom';
import type { KanbanPanel } from './kanban';

/** Um quadro com três colunas de post-its, em pixels (o mesmo traço dos outros ícones da barra). */
const KANBAN_ICON =
  '<svg class="ui-px-icon" width="20" height="20" viewBox="0 0 10 10" shape-rendering="crispEdges" aria-hidden="true" focusable="false">' +
  '<path fill="currentColor" d="M0 1h10v1H0zM0 9h10v1H0zM0 1h1v9H0zM9 1h1v9H9zM2 3h1v2H2zM2 6h1v2H2zM4.5 3h1v4h-1zM7 3h1v3H7z"/></svg>';

export class KanbanLauncher implements UiComponent {
  readonly button: HTMLButtonElement;
  private panel: KanbanPanel | null = null;
  private loading: Promise<KanbanPanel> | null = null;

  /** `mount` coloca a janela do painel na interface quando ela é criada. */
  constructor(
    private readonly ctx: UiContext,
    private readonly mount: (el: HTMLElement) => void,
  ) {
    this.button = iconButton(KANBAN_ICON, tr('Kanban: ideias e tarefas do time (K)'), () => this.toggle());
    this.button.setAttribute('aria-haspopup', 'dialog');
  }

  toggle(): void {
    if (this.panel) this.panel.toggle();
    else
      void this.load()
        .then((p) => p.open())
        .catch(() => this.ctx.announce(tr('Não foi possível abrir o Kanban.')));
  }

  render(): void {
    this.panel?.render();
  }

  private load(): Promise<KanbanPanel> {
    this.loading ??= import('./kanban').then((m) => {
      const panel = new m.KanbanPanel(this.ctx, this.button);
      this.mount(panel.el);
      this.panel = panel;
      return panel;
    });
    // Falhou (rede caiu no meio do download): a próxima tentativa baixa de novo.
    this.loading.catch(() => (this.loading = null));
    return this.loading;
  }
}
