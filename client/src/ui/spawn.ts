// Novo agente (botão na barra do topo): começa uma sessão do Claude Code em segundo plano no Mac, na pasta escolhida e
// com o pedido (POST /api/spawn; server/spawn/spawn.ts). As pastas são os projetos recentes do computador
// (GET /api/spawn/folders: histórico de sessões + salas), para escolher com um toque; "Outra pasta" aceita um caminho
// digitado. O pedido pode levar anexos (POST /api/spawn/attachments, um por arquivo, antes do pedido) e ser ditado
// (ui/dictation.ts, Whisper local no Mac). Pasta que o Claude Code não conhece cai no app (Enter lá).
import { tr } from '../../../shared/i18n';
import { isDemoId } from '../../../shared/timeline';
import type { OfficeSnapshot } from '../../../shared/types';
import type { UiContext } from './context';
import { DictationButton, dictationAvailable, insertDictation } from './dictation';
import { h, iconButton, setHidden, setText } from './dom';
import { ICONS } from './icons';

export const SPAWN_PROMPT_MAX = 8_000;
export const MAX_FILES = 8;
export const MAX_FILE_BYTES = 15 * 1024 * 1024;
const POLL_MS = 700;
/**
 * Quanto a página espera o pedido abrir: mais que o servidor leva para desistir (fila 30 s + `claude --bg` e `open`,
 * 50 s; server/spawn/spawn.ts), para nunca dizer "não confirmou" de algo que ainda vai abrir.
 */
const WAIT_MS = 90_000;
const LAST_FOLDER_KEY = 'habblaud.spawn.folder';

interface SpawnInfo {
  id: string;
  status: 'queued' | 'sent' | 'opened' | 'failed';
  error?: string;
  how?: 'cli' | 'app';
  note?: string;
}

export interface FolderOption {
  path: string;
  name: string;
  lastAt: number;
  sessions?: number;
}

/** A partir de quantas pastas a caixa de pesquisa aparece. */
const SEARCH_MIN = 5;

/** Minúsculas e sem acento, para a pesquisa achar "Resenha" digitando "resenha" ou "RESÉNHA". */
function fold(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/** As pastas que batem com a pesquisa (nome ou caminho, sem diferenciar maiúsculas nem acentos); vazia = todas. */
export function filterFolders<T extends { name: string; path: string }>(folders: readonly T[], query: string): T[] {
  const q = fold(query.trim());
  return q ? folders.filter((f) => fold(f.name).includes(q) || fold(f.path).includes(q)) : [...folders];
}

/** Pastas das salas, da mais recente para a mais antiga (reserva quando o servidor não manda a lista). */
export function spawnFolders(snap: Pick<OfficeSnapshot, 'rooms' | 'agents'> | null | undefined): string[] {
  if (!snap) return [];
  const last = new Map<string, number>();
  for (const a of snap.agents) last.set(a.roomId, Math.max(last.get(a.roomId) ?? 0, a.lastEventAt ?? 0));
  const paths = [...snap.rooms]
    .filter((r) => !isDemoId(r.id) && /^(\/|[A-Za-z]:[\\/])/.test(r.path ?? ''))
    .sort((a, b) => (last.get(b.id) ?? 0) - (last.get(a.id) ?? 0))
    .map((r) => r.path);
  return [...new Set(paths)];
}

/** Caminho curto para a lista: a pasta pessoal vira "~". */
export function shortPath(path: string): string {
  return path.replace(/^\/(Users|home)\/[^/]+(?=\/|$)/, '~').replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/i, '~');
}

/** "agora", "5 min", "3 h", "2 d" (vazio sem horário). */
export function ago(at: number, now = Date.now()): string {
  if (!at) return '';
  const min = Math.max(0, Math.round((now - at) / 60_000));
  if (min < 1) return tr('agora');
  if (min < 60) return `${min} min`;
  const hours = Math.round(min / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

function fileToBase64(file: Blob): Promise<string> {
  return new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => fail(new Error(tr('não deu para ler o arquivo')));
    r.readAsDataURL(file);
  });
}

/**
 * O nome de pasta de um texto livre: "Meu App Novo!" vira "meu-app-novo" (minúsculas, sem acento, só letras, números,
 * `.`, `_` e `-`). O servidor só aceita esse formato (server/spawn/project.ts).
 */
export function slugifyProject(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[.\-_]+$/, '')
    .slice(0, 64);
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init });
  } catch {
    throw new Error(tr('o Habblaud não respondeu'));
  }
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? tr('erro {0}', [res.status]));
  return body;
}

function readPref(): string {
  try {
    return localStorage.getItem(LAST_FOLDER_KEY) ?? '';
  } catch {
    return '';
  }
}

function writePref(path: string): void {
  try {
    localStorage.setItem(LAST_FOLDER_KEY, path);
  } catch {
    // sem armazenamento: só não lembra
  }
}

interface PendingFile {
  file: File;
  url?: string;
  el: HTMLElement;
}

export class SpawnPanel {
  readonly el: HTMLElement;
  private readonly accountBox: HTMLElement;
  private readonly accountList: HTMLElement;
  private readonly folderList: HTMLElement;
  private readonly otherBtn: HTMLButtonElement;
  /** Projeto novo (do zero): nome da pasta, em vez de escolher uma que já existe. */
  private readonly projectBtn: HTMLButtonElement;
  private readonly projectBox: HTMLElement;
  private readonly projectName: HTMLInputElement;
  private readonly projectHint: HTMLElement;
  private projectOn = false;
  /** Onde o servidor cria os projetos novos (GET /api/spawn/project); '' até chegar. */
  private projectDir = '';
  private readonly folder: HTMLInputElement;
  private readonly prompt: HTMLTextAreaElement;
  private readonly fileInput: HTMLInputElement;
  private readonly fileList: HTMLElement;
  private readonly dictate: DictationButton;
  private readonly submitBtn: HTMLButtonElement;
  private readonly status: HTMLElement;
  private anchor?: HTMLElement;
  private busy = false;
  private folders: FolderOption[] = [];
  private selected = '';
  private account = '';
  private typing = false;
  /** O que está digitado na pesquisa de projetos (só filtra a lista; a pasta escolhida não muda). */
  private query = '';
  private readonly search: HTMLInputElement;
  private files: PendingFile[] = [];

  constructor(private readonly ctx: UiContext) {
    this.accountList = h('div', { class: 'ui-spawn__folders', role: 'radiogroup', attrs: { 'aria-label': tr('Contas') } });
    this.accountBox = h('div', { class: 'ui-spawn__accounts' }, h('p', { class: 'ui-spawn__label', text: tr('Conta') }), this.accountList);
    setHidden(this.accountBox, true);
    this.search = h('input', {
      class: 'ui-rename__input ui-spawn__search',
      type: 'search',
      hidden: true,
      attrs: { placeholder: tr('Pesquisar projeto'), spellcheck: 'false', autocomplete: 'off', autocapitalize: 'none', 'aria-label': tr('Pesquisar projeto') },
      on: {
        input: () => {
          this.query = this.search.value;
          this.renderFolders();
        },
        keydown: (e: KeyboardEvent) => {
          e.stopPropagation();
          // Enter escolhe o primeiro resultado; Esc limpa a pesquisa (e só fecha o painel se ela já estava vazia).
          if (e.key === 'Enter') {
            e.preventDefault();
            const first = this.visibleFolders()[0];
            if (first) this.pick(first.path);
          } else if (e.key === 'Escape' && this.search.value) {
            e.preventDefault();
            this.search.value = '';
            this.query = '';
            this.renderFolders();
          }
        },
      },
    });
    this.folderList = h('div', { class: 'ui-spawn__folders', role: 'radiogroup', attrs: { 'aria-label': tr('Projetos recentes') } });
    this.otherBtn = h('button', { class: 'ui-spawn__other', type: 'button', on: { click: () => this.showOther(true) } }, tr('+ Outra pasta'));
    this.projectBtn = h('button', { class: 'ui-spawn__other', type: 'button', on: { click: () => this.setProjectMode(!this.projectOn) } }, tr('+ Projeto novo'));
    this.projectName = h('input', {
      class: 'ui-rename__input ui-spawn__path',
      type: 'text',
      attrs: { id: 'ui-spawn-project', placeholder: tr('Nome do projeto (ex.: minha-aplicacao)'), maxlength: 64, spellcheck: 'false', autocomplete: 'off', autocapitalize: 'none', 'aria-label': tr('Nome do projeto novo') },
      on: { input: () => this.paintProjectHint() },
    });
    this.projectHint = h('p', { class: 'ui-rename__hint ui-spawn__project-hint' });
    this.projectBox = h('div', { class: 'ui-spawn__project', hidden: true }, this.projectName, this.projectHint);
    this.folder = h('input', {
      class: 'ui-rename__input ui-spawn__path',
      type: 'text',
      hidden: true,
      attrs: { id: 'ui-spawn-folder', placeholder: '/Users/voce/projeto', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'none', 'aria-label': tr('Caminho da pasta') },
    });
    this.prompt = h('textarea', {
      class: 'ui-rename__input ui-spawn__prompt',
      attrs: { id: 'ui-spawn-prompt', rows: 5, maxlength: SPAWN_PROMPT_MAX, placeholder: tr('O que o agente deve fazer (opcional)') },
    });
    this.fileInput = h('input', { type: 'file', hidden: true, attrs: { multiple: true, 'aria-hidden': 'true', tabindex: '-1' } });
    this.fileInput.addEventListener('change', () => {
      this.addFiles([...(this.fileInput.files ?? [])]);
      this.fileInput.value = '';
    });
    const attachBtn = h('button', { class: 'ui-btn ui-spawn__attach', type: 'button', attrs: { title: tr('Anexar imagens ou arquivos ao pedido') }, on: { click: () => this.fileInput.click() } });
    const clip = h('span', { attrs: { 'aria-hidden': 'true' } });
    clip.innerHTML = ICONS.attach;
    attachBtn.append(clip, h('span', { text: tr('Anexar') }));
    this.dictate = new DictationButton(
      (t) => {
        const { value, caret } = insertDictation(this.prompt.value, this.prompt.selectionStart ?? this.prompt.value.length, this.prompt.selectionEnd ?? this.prompt.value.length, t.text);
        this.prompt.value = value.slice(0, SPAWN_PROMPT_MAX);
        this.prompt.setSelectionRange(caret, caret);
      },
      (text, error) => this.say(text, error),
    );
    setHidden(this.dictate.el, true);
    this.fileList = h('ul', { class: 'ui-spawn__files', attrs: { 'aria-label': tr('Anexos') } });
    this.submitBtn = h('button', { class: 'ui-btn ui-perm__btn ui-perm__btn--allow ui-spawn__go', type: 'button', on: { click: () => void this.submit() } }, tr('Começar'));
    this.status = h('p', { class: 'ui-rename__hint ui-spawn__status', attrs: { role: 'status', 'aria-live': 'polite' } });
    for (const field of [this.folder, this.prompt, this.projectName] as HTMLElement[]) {
      field.addEventListener('keydown', (e: KeyboardEvent) => {
        e.stopPropagation();
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void this.submit();
        }
      });
      field.addEventListener('keyup', (e) => e.stopPropagation());
    }
    this.folder.addEventListener('input', () => {
      this.selected = this.folder.value.trim();
      this.renderFolders();
    });
    const close = iconButton(ICONS.close, tr('Fechar'), () => this.hide(), 'ui-icon-btn--sm');
    this.el = h(
      'div',
      { class: 'ui-popover ui-spawn', role: 'dialog', tabIndex: -1, attrs: { 'aria-label': tr('Novo agente'), id: 'ui-spawn', popover: 'auto' } },
      h('div', { class: 'ui-popover__head' }, h('h2', { text: tr('Novo agente') }), close),
      h(
        'div',
        { class: 'ui-set-group ui-spawn__body' },
        this.accountBox,
        h('p', { class: 'ui-spawn__label', attrs: { id: 'ui-spawn-folders-label' }, text: tr('Projeto') }),
        this.search,
        this.folderList,
        this.otherBtn,
        this.folder,
        this.projectBtn,
        this.projectBox,
        h('label', { class: 'ui-spawn__label', attrs: { for: 'ui-spawn-prompt' }, text: tr('Pedido') }),
        this.prompt,
        h('div', { class: 'ui-spawn__tools' }, this.dictate.el, attachBtn, this.fileInput),
        this.fileList,
        h('p', { class: 'ui-rename__hint', text: tr('Começa na hora uma sessão do Claude Code em segundo plano no computador, na pasta escolhida; as permissões chegam aqui. Pasta que o Claude Code ainda não conhece abre no app do Claude e espera o Enter lá. Anexos vão para ~/.habblaud/attachments e o pedido leva os caminhos.') }),
        this.submitBtn,
        this.status,
      ),
    );
    this.el.addEventListener('toggle', () => {
      this.anchor?.setAttribute('aria-expanded', String(this.isOpen));
      if (!this.isOpen) this.dictate.cancel();
    });
  }

  get isOpen(): boolean {
    try {
      return this.el.matches(':popover-open');
    } catch {
      return this.el.classList.contains('is-open');
    }
  }

  toggle(anchor: HTMLElement): void {
    this.anchor = anchor;
    if (this.isOpen) return this.hide();
    // Primeiro com o que o escritório já sabe; a lista do servidor (histórico) chega logo depois.
    if (!this.folders.length) this.setFolders(spawnFolders(this.ctx.store.snapshot).map((path) => ({ path, name: path.split(/[\\/]/).pop() || path, lastAt: 0 })));
    this.renderAccounts();
    void this.loadFolders();
    void this.checkDictation();
    if (!this.busy) setText(this.status, '');
    const r = anchor.getBoundingClientRect();
    this.el.style.top = `${Math.round(r.bottom + 8)}px`;
    this.el.style.right = `${Math.max(8, Math.round(innerWidth - r.right - 4))}px`;
    if (typeof this.el.showPopover === 'function') this.el.showPopover();
    else this.el.classList.add('is-open');
    anchor.setAttribute('aria-expanded', 'true');
    // No celular, focar o campo abriria o teclado por cima da lista de projetos.
    if (!matchMedia('(pointer: coarse)').matches) this.prompt.focus();
  }

  hide(): void {
    this.dictate.cancel();
    if (typeof this.el.hidePopover === 'function' && this.isOpen) this.el.hidePopover();
    this.el.classList.remove('is-open');
    this.anchor?.setAttribute('aria-expanded', 'false');
  }

  private async loadFolders(): Promise<void> {
    try {
      const r = await api<{ folders: FolderOption[] }>('/api/spawn/folders');
      if (Array.isArray(r.folders) && r.folders.length) this.setFolders(r.folders);
    } catch {
      // fica a lista das salas
    }
  }

  private async checkDictation(): Promise<void> {
    setHidden(this.dictate.el, !(await dictationAvailable()));
  }

  private setFolders(list: FolderOption[]): void {
    this.folders = list;
    if (!this.selected) {
      const pref = readPref();
      this.selected = list.some((f) => f.path === pref) ? pref : (list[0]?.path ?? '');
    }
    this.renderFolders();
  }

  /** Só aparece com mais de uma conta do Claude Code: com uma só, não há o que escolher. */
  private renderAccounts(): void {
    const list = (this.ctx.store.snapshot?.accounts ?? []).filter((a) => (a.provider ?? 'claude') === 'claude');
    setHidden(this.accountBox, list.length < 2);
    if (list.length < 2) {
      this.account = '';
      this.accountList.replaceChildren();
      return;
    }
    if (!list.some((a) => a.id === this.account)) this.account = list[0].id;
    this.accountList.replaceChildren(
      ...list.map((a) => {
        const on = a.id === this.account;
        return h(
          'button',
          {
            class: `ui-spawn__folder${on ? ' is-on' : ''}`,
            type: 'button',
            role: 'radio',
            attrs: { 'aria-checked': String(on), title: a.configDir },
            on: {
              click: () => {
                this.account = a.id;
                this.renderAccounts();
              },
            },
          },
          h('span', { class: 'ui-spawn__folder-name', text: a.name }),
          a.email ? h('span', { class: 'ui-spawn__folder-path', text: a.email }) : null,
        );
      }),
    );
  }

  private visibleFolders(): FolderOption[] {
    return filterFolders(this.folders, this.query);
  }

  private renderFolders(): void {
    const now = Date.now();
    const known = this.folders.some((f) => f.path === this.selected);
    const shown = this.visibleFolders();
    // Com poucas pastas, pesquisar só atrapalha; se já há uma pesquisa, a caixa fica para poder limpá-la.
    setHidden(this.search, this.folders.length < SEARCH_MIN && !this.query);
    this.folderList.replaceChildren(
      ...(this.query && !shown.length ? [h('p', { class: 'ui-rename__hint', text: tr('Nenhum projeto encontrado.') })] : []),
      ...shown.map((f) => {
        const on = f.path === this.selected && !this.typing && !this.projectOn;
        const when = ago(f.lastAt, now);
        return h(
          'button',
          {
            class: `ui-spawn__folder${on ? ' is-on' : ''}`,
            type: 'button',
            role: 'radio',
            attrs: { 'aria-checked': String(on), title: f.path },
            on: { click: () => this.pick(f.path) },
          },
          h('span', { class: 'ui-spawn__folder-name', text: f.name }),
          h('span', { class: 'ui-spawn__folder-path', text: shortPath(f.path) }),
          when ? h('span', { class: 'ui-spawn__folder-when', text: when }) : null,
        );
      }),
    );
    if (!this.folders.length) this.showOther(true);
    else if (!known && this.selected && !this.typing && !this.projectOn) this.showOther(true, this.selected);
  }

  private pick(path: string): void {
    this.setProjectMode(false);
    this.selected = path;
    this.typing = false;
    setHidden(this.folder, true);
    this.otherBtn.classList.remove('is-on');
    this.renderFolders();
  }

  private showOther(on: boolean, value?: string): void {
    if (on) this.setProjectMode(false);
    this.typing = on;
    setHidden(this.folder, !on);
    this.otherBtn.classList.toggle('is-on', on);
    if (on) {
      if (value !== undefined) this.folder.value = value;
      this.selected = this.folder.value.trim();
      this.folderList.querySelectorAll('.ui-spawn__folder').forEach((b) => {
        b.classList.remove('is-on');
        b.setAttribute('aria-checked', 'false');
      });
      if (value === undefined) this.folder.focus();
    }
  }

  /** Liga ou desliga o modo "projeto novo": a pasta é criada na hora de começar, com o nome digitado aqui. */
  private setProjectMode(on: boolean): void {
    if (on === this.projectOn) return;
    this.projectOn = on;
    setHidden(this.projectBox, !on);
    this.projectBtn.classList.toggle('is-on', on);
    setText(this.submitBtn, on ? tr('Criar projeto e começar') : tr('Começar'));
    this.prompt.placeholder = on ? tr('Descreva a ideia da aplicação (a primeira sessão começa com isso)') : tr('O que o agente deve fazer (opcional)');
    if (on) {
      this.typing = false;
      setHidden(this.folder, true);
      this.otherBtn.classList.remove('is-on');
      this.paintProjectHint();
      void this.loadProjectDir();
      if (!matchMedia('(pointer: coarse)').matches) this.projectName.focus();
    }
    this.renderFolders();
  }

  private async loadProjectDir(): Promise<void> {
    if (this.projectDir) return;
    try {
      this.projectDir = (await api<{ dir: string }>('/api/spawn/project')).dir;
    } catch (err) {
      // Docker ou sem liberação: o servidor explica por que não dá para criar projeto por aqui.
      this.say((err as Error).message, true);
    }
    this.paintProjectHint();
  }

  private paintProjectHint(): void {
    const raw = this.projectName.value.trim();
    const slug = slugifyProject(raw);
    const where = this.projectDir ? `${this.projectDir.replace(/[\\/]+$/, '')}/${slug || '…'}` : '';
    const rename = slug && slug !== raw ? tr('Nome da pasta: {0}. ', [slug]) : '';
    setText(this.projectHint, `${rename}${where ? tr('Será criada em {0}, com git. Para publicar no GitHub, peça ao agente na conversa.', [where]) : ''}`);
  }

  /** Cria a pasta (e o git) e abre a primeira sessão do Claude Code nela, já com a ideia digitada em "Pedido". */
  private async submitProject(): Promise<void> {
    const name = slugifyProject(this.projectName.value);
    if (!name) return this.say(tr('Dê um nome ao projeto.'), true);
    if (this.files.length) return this.say(tr('Anexos ainda não valem em projeto novo: tire-os, ou anexe pelo chat depois que a sessão abrir.'), true);
    const terminals = this.ctx.terminals;
    if (!terminals) return this.say(tr('O terminal ainda não está pronto.'), true);
    this.busy = true;
    this.submitBtn.disabled = true;
    try {
      this.say(tr('Criando a pasta…'));
      const made = await api<{ name: string; path: string; git: boolean; note?: string }>('/api/spawn/project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      this.say(tr('Pasta criada. Abrindo a primeira sessão…'));
      await terminals.newSession(made.path, this.account || undefined, undefined, this.prompt.value.trim() || undefined);
      writePref(made.path);
      this.say(made.note ? made.note : tr('Pronto: {0} criado. Se o Claude Code perguntar se confia na pasta, responda no terminal que abriu.', [made.path]), !!made.note);
      this.prompt.value = '';
      this.projectName.value = '';
      this.setProjectMode(false);
      this.selected = made.path;
      void this.loadFolders();
      this.ctx.announce(tr('Projeto novo criado.'));
      this.hide();
    } catch (err) {
      this.say(tr('Não deu: {0}', [(err as Error).message]), true);
    } finally {
      this.busy = false;
      this.submitBtn.disabled = false;
    }
  }

  private addFiles(list: File[]): void {
    for (const file of list) {
      if (this.files.length >= MAX_FILES) {
        this.say(tr('No máximo {0} anexos por pedido.', [MAX_FILES]), true);
        break;
      }
      if (file.size > MAX_FILE_BYTES) {
        this.say(tr('{0} passa de {1} MB.', [file.name, MAX_FILE_BYTES / 1024 / 1024]), true);
        continue;
      }
      if (!file.size) continue;
      const url = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
      const item: PendingFile = { file, url, el: h('li', { class: 'ui-spawn__file' }) };
      const thumb = url ? h('img', { class: 'ui-spawn__thumb', attrs: { src: url, alt: '' } }) : h('span', { class: 'ui-spawn__thumb ui-spawn__thumb--doc', attrs: { 'aria-hidden': 'true' }, text: (file.name.split('.').pop() ?? '').slice(0, 4).toUpperCase() || tr('ARQ') });
      const remove = iconButton(ICONS.close, tr('Tirar {0}', [file.name]), () => this.removeFile(item), 'ui-icon-btn--sm ui-spawn__file-x');
      item.el.append(thumb, h('span', { class: 'ui-spawn__file-name', text: file.name, attrs: { title: file.name } }), h('span', { class: 'ui-spawn__file-size', text: formatBytes(file.size) }), remove);
      this.files.push(item);
      this.fileList.append(item.el);
    }
  }

  private removeFile(item: PendingFile): void {
    if (item.url) URL.revokeObjectURL(item.url);
    item.el.remove();
    this.files = this.files.filter((f) => f !== item);
  }

  private clearFiles(): void {
    for (const f of [...this.files]) this.removeFile(f);
  }

  private say(text: string, error = false): void {
    setText(this.status, text);
    this.status.classList.toggle('is-error', error);
  }

  private async submit(): Promise<void> {
    if (this.busy) return;
    if (this.dictate.busy) return this.say(tr('Espere o ditado terminar.'), true);
    if (this.projectOn) return this.submitProject();
    const folder = (this.typing ? this.folder.value : this.selected).trim();
    if (!folder) return this.say(tr('Escolha o projeto.'), true);
    this.busy = true;
    this.submitBtn.disabled = true;
    try {
      const ids: string[] = [];
      for (const [i, f] of this.files.entries()) {
        this.say(this.files.length > 1 ? tr('Enviando anexos ({0} de {1})…', [i + 1, this.files.length]) : tr('Enviando o anexo…'));
        const r = await api<{ id: string }>('/api/spawn/attachments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: f.file.name, type: f.file.type, data: await fileToBase64(f.file) }),
        });
        ids.push(r.id);
      }
      this.say(tr('Começando no computador…'));
      let info = await api<SpawnInfo>('/api/spawn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          folder,
          prompt: this.prompt.value,
          ...(this.account ? { account: this.account } : {}),
          ...(ids.length ? { attachments: ids } : {}),
        }),
      });
      const end = Date.now() + WAIT_MS;
      while ((info.status === 'queued' || info.status === 'sent') && Date.now() < end) {
        await new Promise((ok) => setTimeout(ok, POLL_MS));
        info = await api<SpawnInfo>(`/api/spawn/${encodeURIComponent(info.id)}`);
      }
      if (info.status === 'opened') {
        const running = info.how === 'cli';
        this.say(
          running
            ? tr('Rodando: a sessão já começou no computador e aparece no escritório em instantes.')
            : info.note
              ? tr('Abri no app do Claude: aperte Enter lá para começar. Não rodou sozinho: {0}.', [info.note])
              : tr('Abri no app do Claude: aperte Enter lá para começar.'),
          !running && !!info.note,
        );
        this.prompt.value = '';
        this.clearFiles();
        writePref(folder);
        this.ctx.announce(running ? tr('Agente novo rodando.') : tr('Agente novo aberto no app do Claude.'));
      } else this.say(info.error ? tr('Não abriu: {0}', [info.error]) : tr('O computador não confirmou a abertura.'), true);
    } catch (err) {
      this.say(tr('Não abriu: {0}', [(err as Error).message]), true);
    } finally {
      this.busy = false;
      this.submitBtn.disabled = false;
    }
  }
}
