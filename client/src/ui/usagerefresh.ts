// Botão da barra de uso que atualiza o uso das contas na hora (POST /api/usage/refresh). O Habblaud só lê arquivos que
// o Claude Code grava (statusline enquanto uma sessão roda, cache do /usage), então uma conta sem sessão aberta
// envelhece; o servidor roda `claude -p /usage` em cada conta do Claude Code e relê o cache (accounts/usage-refresh.ts).
// Só pelo próprio computador (AccessInfo.usageRefresh), fora do demo e do timelapse.
import { access } from '../net/access';
import type { UiComponent, UiContext } from './context';
import { h, iconButton, setHidden, setText, setTitle } from './dom';
import { ICONS } from './icons';
import { postPty } from './ptyapi';
import { tr } from '../../../shared/i18n';

export interface RefreshResultInfo {
  account: string;
  name?: string;
  ok: boolean;
  error?: string;
}

/** Quanto tempo a mensagem de resultado fica ao lado do botão. */
const MESSAGE_MS = 8_000;

/** Resumo do resultado da atualização: o texto curto e se houve falha. */
export function refreshSummary(results: readonly RefreshResultInfo[]): { text: string; failed: boolean } {
  if (!results.length) return { text: tr('Nenhuma conta do Claude Code para atualizar.'), failed: true };
  const bad = results.filter((r) => !r.ok);
  if (!bad.length) return { text: results.length === 1 ? tr('Uso atualizado.') : tr('Uso de {0} contas atualizado.', [results.length]), failed: false };
  const why = bad.map((r) => `${r.name ?? r.account}: ${r.error ?? tr('falhou')}`).join(' · ');
  return { text: bad.length === results.length ? tr('Não deu para atualizar: {0}', [why]) : tr('Atualizado, menos: {0}', [why]), failed: true };
}

export class UsageRefreshButton implements UiComponent {
  readonly el: HTMLElement;
  private btn: HTMLButtonElement;
  private msg: HTMLElement;
  private busy = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private ctx: UiContext) {
    this.btn = iconButton(ICONS.refresh, tr('Atualizar o uso das contas'), () => void this.run(), 'ui-usage-refresh__btn');
    this.msg = h('span', { class: 'ui-usage-refresh__msg', role: 'status', hidden: true, attrs: { 'aria-live': 'polite' } });
    this.el = h('span', { class: 'ui-usage-refresh', hidden: true }, this.btn, this.msg);
  }

  render(): void {
    const store = this.ctx.store;
    const accounts = store.snapshot?.accounts ?? [];
    const on = !!access().usageRefresh && !store.mock && !store.replaying && accounts.some((a) => a.provider !== 'codex');
    setHidden(this.el, !on);
    this.el.classList.toggle('is-busy', this.busy);
    this.btn.disabled = this.busy;
    setTitle(this.btn, this.busy ? tr('Atualizando o uso…') : tr('Atualizar o uso das contas'));
  }

  private say(text: string, error = false): void {
    if (this.timer) clearTimeout(this.timer);
    setText(this.msg, text);
    setHidden(this.msg, !text);
    this.msg.classList.toggle('is-error', error);
    setTitle(this.msg, text);
    if (text && !this.busy) this.timer = setTimeout(() => this.say(''), MESSAGE_MS);
  }

  private async run(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.say(tr('Atualizando…'));
    this.ctx.invalidate();
    try {
      const r = await postPty<{ results: RefreshResultInfo[] }>('/api/usage/refresh', {});
      this.busy = false;
      const s = refreshSummary(r?.results ?? []);
      this.say(s.text, s.failed);
      this.ctx.announce(s.text);
    } catch (err) {
      this.busy = false;
      const text = err instanceof Error ? err.message : tr('Não deu para atualizar o uso.');
      this.say(text, true);
      this.ctx.announce(text);
    }
    this.ctx.invalidate();
  }
}
