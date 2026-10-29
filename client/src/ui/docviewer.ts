// Visualizador de documentos markdown citados no chat: clicar no caminho abre o arquivo formatado, na mesma janela
// cheia dos anexos das Entregas (mesmos estilos). O servidor só entrega .md de pasta de projeto conhecida (deliveries/docs.ts).
import { tr } from '../../../shared/i18n';
import { h, iconButton, setText } from './dom';
import { ICONS } from './icons';
import { renderMarkdown } from './markdown';

/** Caminho de markdown escrito como código no chat: sem espaços, termina em .md ou .markdown. */
const DOC_PATH = /^(?:~?\/)?[\w@%+.-]+(?:\/[\w@%+.-]+)*\.(?:md|markdown)$/i;

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

let dialog: HTMLDialogElement | undefined;
let titleEl: HTMLElement;
let bodyEl: HTMLElement;
let openEl: HTMLAnchorElement;

function ensureDialog(): HTMLDialogElement {
  if (dialog) return dialog;
  titleEl = h('span', { class: 'ui-deliv-viewer__title' });
  openEl = h('a', { class: 'ui-btn ui-deliv-viewer__open', text: tr('Abrir'), attrs: { target: '_blank', rel: 'noopener' } }) as HTMLAnchorElement;
  bodyEl = h('div', { class: 'ui-deliv-viewer__body' });
  const d = h(
    'dialog',
    { class: 'ui-deliv-viewer', attrs: { 'aria-label': tr('Documento') } },
    h('div', { class: 'ui-deliv-viewer__bar' }, h('div', { class: 'ui-deliv-viewer__label' }, titleEl), openEl, iconButton(ICONS.close, tr('Fechar'), () => d.close(), 'ui-icon-btn--sm')),
    bodyEl,
  ) as HTMLDialogElement;
  d.addEventListener('close', () => bodyEl.replaceChildren());
  document.body.append(d);
  dialog = d;
  return d;
}

/** Abre o markdown `path` (relativo ao projeto, ou absoluto) no visualizador. */
export function openDoc(project: string, path: string): void {
  const d = ensureDialog();
  const url = docUrl(project, path);
  setText(titleEl, path);
  openEl.href = url;
  const box = h('div', { class: 'ui-deliv-viewer__text ui-deliv-viewer__md ui-md', text: tr('Carregando…') });
  bodyEl.replaceChildren(box);
  if (!d.open) d.showModal();
  void fetch(url, { credentials: 'same-origin' })
    .then(async (r) => (r.ok ? r.text() : Promise.reject(new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? tr('erro {0}', [r.status])))))
    .then(
      (t) => {
        box.textContent = '';
        box.append(renderMarkdown(t.slice(0, 200_000)));
      },
      (e: Error) => setText(box, tr('Não deu para abrir: {0}', [e.message])),
    );
}
