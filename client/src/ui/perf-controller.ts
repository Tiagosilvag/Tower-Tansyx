// Desempenho na interface: resolve o nível que vale (o automático liga o leve quando o escritório fica lento), passa
// para o mundo, limita as linhas do chat no mínimo, pausa o escritório com um terminal em tela cheia e mostra a linha
// de diagnóstico. A decisão em si é pura (ui/perf.ts); aqui fica o que mexe na página.
import type { Notice } from '../../../shared/types';
import { tr } from '../../../shared/i18n';
import type { UiContext } from './context';
import { h, setHidden, setText } from './dom';
import { AutoGovernor, CHAT_ROWS, levelOf, type PerfLevel, type PerfMode } from './perf';
import { setTerminalDomLimit } from './terminal';

export class PerfController {
  /** Linha de diagnóstico (canto da tela); só aparece com a opção ligada. */
  readonly el: HTMLElement;
  private autoLevel: PerfLevel = 'normal';
  private readonly governor = new AutoGovernor();
  private lastMode: PerfMode;
  private pausedWorld = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly ctx: UiContext,
    private readonly toast: (n: Notice) => void,
    private readonly inCity: () => boolean,
  ) {
    this.lastMode = ctx.prefs.perf;
    this.el = h('div', { class: 'ui-perf-stats', role: 'status', hidden: true });
  }

  level(): PerfLevel {
    return levelOf(this.ctx.prefs.perf, this.autoLevel);
  }

  /** Chame depois de qualquer mudança de preferência (e no início): aplica o nível que vale. */
  apply(): void {
    const mode = this.ctx.prefs.perf;
    if (mode !== this.lastMode) {
      // Voltar ao automático recomeça do normal: ele decide de novo conforme a medida.
      this.lastMode = mode;
      this.autoLevel = 'normal';
      this.governor.reset();
    }
    const level = this.level();
    this.ctx.world.setOptions({ perf: level });
    this.ctx.root.classList.toggle('is-perf-light', level === 'light');
    this.ctx.root.classList.toggle('is-perf-min', level === 'min');
    setTerminalDomLimit(CHAT_ROWS[level]);
    if (level !== 'min') this.resumeWorld();
    this.drawStats();
  }

  start(): void {
    this.timer ??= setInterval(() => this.tick(), 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    const fps = this.ctx.world.fps?.() ?? 0;
    if (this.ctx.prefs.perf === 'auto' && this.governor.sample(fps, this.level())) {
      this.autoLevel = 'light';
      this.apply();
      this.toast({
        id: `perf-auto-${Date.now()}`,
        level: 'warn',
        text: tr('Modo leve ligado automaticamente: o escritório estava a {0} quadros por segundo. Para voltar ao Normal, abra Configurações › Desempenho.', [fps]),
        at: Date.now(),
      });
    }
    // Mínimo: com um terminal em tela cheia o escritório fica escondido, então para de desenhar.
    if (this.level() === 'min' && !this.inCity()) {
      const covered = !!document.querySelector('.ui-term.is-max');
      if (covered && !this.pausedWorld) {
        this.pausedWorld = true;
        this.ctx.world.setSuspended?.(true);
      } else if (!covered) this.resumeWorld();
    }
    this.drawStats();
  }

  private resumeWorld(): void {
    if (!this.pausedWorld) return;
    this.pausedWorld = false;
    if (!this.inCity()) this.ctx.world.setSuspended?.(false);
  }

  private drawStats(): void {
    const on = this.ctx.prefs.perfStats;
    setHidden(this.el, !on);
    if (!on) return;
    const fps = this.pausedWorld ? 0 : (this.ctx.world.fps?.() ?? 0);
    const rows = document.querySelectorAll('.ui-term__row').length;
    const modes: Record<PerfLevel, string> = { normal: tr('Normal'), light: tr('Leve'), min: tr('Mínimo') };
    const auto = this.ctx.prefs.perf === 'auto' ? ` (${tr('automático')})` : '';
    setText(this.el, `${fps} ${tr('quadros/s')} · ${tr('chat')} ${rows} ${tr('linhas')} · ${modes[this.level()]}${auto}`);
  }
}
