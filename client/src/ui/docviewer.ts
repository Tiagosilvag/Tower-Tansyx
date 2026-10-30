// Visualizador de documentos markdown citados no chat: clicar no caminho abre o arquivo formatado numa janela flutuante,
// como o Kanban (arrasta pela barra, puxa as bordas, expande, não escurece nem bloqueia o escritório). Uma janela só: abrir
// outro documento troca o conteúdo. O servidor só entrega .md de pasta de projeto conhecida (server/deliveries/docs.ts).
import { tr } from '../../../shared/i18n';
import { copyText, h, iconButton, setHidden, setText } from './dom';
import { ICONS } from './icons';
import { renderMarkdown } from './markdown';
import { layoutButton } from './layouts';
import { maximizeButton, Movable } from './movable';

/** Caminho de markdown escrito como código no chat: sem espaços, termina em .md ou .markdown. */
const DOC_PATH = /^(?:~?\/)?[\w@%+.-]+(?:\/[\w@%+.-]+)*\.(?:md|markdown)$/i;
const MAX_CHARS = 400_000;

export function isDocPath(text: string): boolean {
  return text.length <= 300 && DOC_PATH.test(text) && !text.includes('..');
}

/** Marca como clicáveis os caminhos .md escritos como código dentro de `root`. */
export function markDocPaths(root: ParentNode): void {
  for (const code of root.querySelectorAll<HTMLElement>('code.ui-md__code')) {
    const text = code.textContent ?? '';
    if (!isDocPath(text)) continue;
    code.dataset.doc = text;
    code.classList.add('is-doc');
    code.tabIndex = 0;
    code.setAttribute('role', 'button');
    code.title = tr('Abrir {0}', [text]);
  }
}

export function docUrl(project: string, path: string): string {
  return `/api/doc?${new URLSearchParams({ project, path }).toString()}`;
}

class DocWindow {
  readonly el: HTMLDialogElement;
  private readonly nameEl: HTMLElement;
  private readonly pathEl: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private readonly openEl: HTMLAnchorElement;
  private readonly refreshBtn: HTMLButtonElement;
  private readonly copyBtn: HTMLButtonElement;
  private readonly exportBtn: HTMLButtonElement;
  private readonly movable: Movable;
  private project = '';
  private path = '';
  private text = '';
  private seq = 0;
  private opener: HTMLElement | null = null;

  constructor() {
    this.nameEl = h('h2', { class: 'ui-doc__name', attrs: { id: 'ui-doc-title' } });
    this.pathEl = h('span', { class: 'ui-doc__path' });
    this.openEl = h('a', { class: 'ui-btn ui-btn--sm ui-doc__open', text: tr('Abrir'), attrs: { target: '_blank', rel: 'noopener' } }) as HTMLAnchorElement;
    this.refreshBtn = iconButton(ICONS.refresh, tr('Atualizar o documento'), () => void this.load(), 'ui-icon-btn--sm ui-doc__refresh');
    this.copyBtn = iconButton(ICONS.copy, tr('Copiar o texto'), () => this.copy(), 'ui-icon-btn--sm');
    this.exportBtn = iconButton(ICONS.download, tr('Exportar o .md'), () => this.export(), 'ui-icon-btn--sm');
    const close = iconButton(ICONS.close, tr('Fechar (Esc)'), () => this.close(), 'ui-icon-btn--sm');
    this.bodyEl = h('div', { class: 'ui-doc__body' });
    const bar = h(
      'div',
      { class: 'ui-doc__bar' },
      h('div', { class: 'ui-doc__label' }, this.nameEl, this.pathEl),
      this.openEl,
      this.refreshBtn,
      this.copyBtn,
      this.exportBtn,
      layoutButton(() => this.movable),
      maximizeButton(() => this.movable),
      close,
    );
    this.el = h('dialog', { class: 'ui-dialog ui-doc', attrs: { 'aria-labelledby': 'ui-doc-title' } }, bar, this.bodyEl) as HTMLDialogElement;
    this.movable = new Movable(this.el, bar, { key: 'habblaud.move.doc', enabled: () => window.innerWidth > 760 });
    // O teclado fica na janela (os atalhos do escritório não disparam por baixo); sem fundo escurecido, o Esc é nosso.
    this.el.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.close();
    });
    this.el.addEventListener('close', () => {
      this.bodyEl.replaceChildren();
      this.seq++;
      this.opener?.focus?.();
      this.opener = null;
    });
    // Dentro do .ui-root: é lá que ficam as variáveis de cor e tipografia (no body o fundo sai transparente).
    (document.querySelector('.ui-root') ?? document.body).append(this.el);
  }

  show(project: string, path: string): void {
    this.project = project;
    this.path = path;
    if (!this.el.open) {
      this.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      this.el.show();
    }
    this.bodyEl.scrollTop = 0;
    setText(this.nameEl, path.split('/').pop() ?? path);
    setText(this.pathEl, path);
    this.openEl.href = docUrl(project, path);
    void this.load();
  }

  close(): void {
    if (this.el.open) this.el.close();
  }

  private copy(): void {
    if (!this.text) return;
    void copyText(this.text);
    this.copyBtn.classList.add('is-done');
    setTimeout(() => this.copyBtn.classList.remove('is-done'), 1200);
  }

  /** Baixa o markdown como arquivo, com o nome do original (o link temporário fica dentro da janela). */
  private export(): void {
    if (!this.text) return;
    const name = this.path.split('/').pop() || 'documento.md';
    const url = URL.createObjectURL(new Blob([this.text], { type: 'text/markdown;charset=utf-8' }));
    const a = h('a', { hidden: true, attrs: { href: url, download: name } });
    this.el.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    this.exportBtn.classList.add('is-done');
    setTimeout(() => this.exportBtn.classList.remove('is-done'), 1200);
  }

  private async load(): Promise<void> {
    const seq = ++this.seq;
    this.refreshBtn.classList.add('is-spinning');
    const keep = this.text ? this.bodyEl.scrollTop : 0;
    if (!this.text) this.bodyEl.replaceChildren(h('p', { class: 'ui-doc__state', text: tr('Carregando…') }));
    let box: HTMLElement;
    try {
      const r = await fetch(docUrl(this.project, this.path), { credentials: 'same-origin' });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? tr('erro {0}', [r.status]));
      const t = await r.text();
      if (seq !== this.seq) return;
      this.text = t;
      const clipped = t.length > MAX_CHARS;
      box = h('article', { class: 'ui-doc__md ui-md' });
      box.append(renderMarkdown(clipped ? t.slice(0, MAX_CHARS) : t));
      if (clipped) box.append(h('p', { class: 'ui-doc__state', text: tr('Documento grande: só o começo aparece aqui. Use Abrir para ver tudo.') }));
    } catch (e) {
      if (seq !== this.seq) return;
      this.text = '';
      box = h('p', { class: 'ui-doc__state is-error', text: tr('Não deu para abrir: {0}', [(e as Error).message]) });
    }
    setHidden(this.copyBtn, !this.text);
    setHidden(this.exportBtn, !this.text);
    this.bodyEl.replaceChildren(box);
    this.bodyEl.scrollTop = keep;
    this.refreshBtn.classList.remove('is-spinning');
  }
}

let win: DocWindow | undefined;

/** Abre o markdown `path` (relativo ao projeto, ou absoluto) na janela de documentos. */
export function openDoc(project: string, path: string): void {
  (win ??= new DocWindow()).show(project, path);
}
