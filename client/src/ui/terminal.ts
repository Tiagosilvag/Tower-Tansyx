// Terminal: janela flutuante sobre o escritório com a conversa de uma sessão (prompts, respostas, ferramentas e
// resultados) no formato em que o Claude Code a mostra, ao vivo pelo stream SSE GET /api/agents/:id/terminal (`init`
// substitui tudo; `append` acrescenta). O rodapé tem a caixa de mensagem (ui/composer.ts): com o plugin
// habblaud-mensagens, o que você digita ali entra na sessão do agente principal como se fosse digitado no terminal.
// Também mostra as sessões do histórico (ui/history.ts), pelo mesmo protocolo em
// GET /api/sessions/:conta/:sessionId/terminal: o cabeçalho traz projeto, título e data, e o rodapé, "Sessão encerrada às …".
// Busca (Ctrl/⌘+F ou a lupa), filtro e o botão de copiar de cada entrada vêm de ui/termtools.ts.
// O modelo (deduplicação, junção ferramenta -> resultado, limite de entradas, prévias recolhidas e rodapé) é puro e
// testado em ui/terminal.test.ts; a montagem usa só textContent (o markdown das respostas vem de ui/markdown.ts).
// Sessão do Codex: selo "Codex" no cabeçalho e um spinner neutro no rodapé (o ✻ é do Claude Code).
import type { AgentInfo, Provider, RecentSession, TerminalEntry, TerminalImage, TerminalInit } from '../../../shared/types';
import { roomTheme } from '../art';
import { MessageComposer } from './composer';
import { SessionChips } from './sessionchips';
import type { UiComponent, UiContext, WindowOptions } from './context';
import { askQuestionNodes, PermissionCard } from './permission';
import { presenceStrip } from './presence';
import { copyText, h, iconButton, prefersReducedMotion, setAttr, setHidden, setText, setTitle, setVariant } from './dom';
import { calendarDayDiff, formatClock, formatDateTime, formatDuration, formatElapsed, relativeTime } from './format';
import { ICONS } from './icons';
import { layoutButton } from './layouts';
import { maximizeButton, Movable } from './movable';
import type { PtyControl } from './pty';
import { TermActions } from './termactions';
import { TermTabs } from './termtabs';
import { markDocPaths, openDoc } from './docviewer';
import { renderMarkdown } from './markdown';
import { roleLabel, shellWaitIn } from './model';
import { providerOf } from './provider';
import { confirmDelete } from './confirm';
import { hideRemoved, ptyControllable, ptyOfAgent, sendPtyKeys } from './ptyapi';
import { DELETE_LAST_STEPS } from './session-info';
import {
  clearHits,
  copyTextOf,
  finalAnswerKeys,
  foldQuery,
  globalIndex,
  hasMedia,
  highlightHits,
  itemVisible,
  refAt,
  searchCounter,
  stepMatch,
  TERMINAL_FILTERS,
  DEFAULT_TERMINAL_FILTER,
  type TerminalFilter,
} from './termtools';
import { chosenLabels, parseAskAnswers, parseAskInput, type AskQuestion } from './termask';
import { createAccountChip, createProviderTag, updateAccountChip, updateProviderTag } from './widgets';
import { intlLocale, tr } from '../../../shared/i18n';

/** Máximo de itens no DOM: os mais antigos saem primeiro. */
export const TERMINAL_DOM_LIMIT = 1500;
let domLimit = TERMINAL_DOM_LIMIT;
/** Linhas mantidas na tela (o modo mínimo de Configurações › Desempenho baixa o limite; ui/perf.ts). */
export function setTerminalDomLimit(n: number): void {
  domLimit = Math.max(50, Math.floor(n));
}
/** Linhas do resultado visíveis antes do "… +N linhas". */
export const RESULT_PREVIEW_LINES = 6;
/** Entrada de ferramenta (comando, diff, JSON) longa: recolhida nas primeiras linhas. */
export const INPUT_PREVIEW_LINES = 10;
/** Prompt do usuário muito longo (texto colado): recolhido. */
export const PROMPT_PREVIEW_LINES = 24;

export const TERMINAL_UNAVAILABLE_HINT = tr('O terminal só fica disponível quando o Habblaud roda com acesso local (bind 127.0.0.1)');
const OPEN_ERROR = tr('Não foi possível abrir o terminal. O recurso só funciona no acesso local, com o agente ainda aberto.');
const SESSION_OPEN_ERROR = tr('Não foi possível abrir a sessão. O histórico só funciona no acesso local, com o transcript ainda no disco.');
/** Espera depois da última tecla antes de buscar (a busca percorre toda a conversa na tela). */
const SEARCH_DEBOUNCE_MS = 120;
/** "Copiado" fica à mostra por este tempo. */
const COPIED_MS = 1_500;
const dayFmt = new Intl.DateTimeFormat(intlLocale(), { day: '2-digit', month: 'short' });

/** Distância do fim (px) que ainda conta como "no fim" para seguir as mensagens novas. */
const STICK_PX = 32;
/** EventSource.CLOSED (constante literal, como no store). */
const ES_CLOSED = 2;
/** Quadros do spinner do Claude Code (vai e volta). */
const SPINNER = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
/** Codex: um spinner neutro (pontos girando), com o mesmo número de quadros. */
const CODEX_SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_MS = 120;
/** "⏺" com seletor de variação de texto: nunca vira emoji colorido (a cor vem do CSS). */
const DOT = '⏺︎';

// ---------------------------------------------------------------- modelo (puro)

export type ToolEntry = Extract<TerminalEntry, { kind: 'tool' }>;
export type ResultEntry = Extract<TerminalEntry, { kind: 'result' }>;
export type PlainEntry = Exclude<TerminalEntry, ToolEntry | ResultEntry>;

/** O que vira uma linha no terminal: uma entrada simples, uma ferramenta (com o resultado, quando chega) ou um resultado órfão. */
export type TerminalItem =
  | { type: 'entry'; key: string; entry: PlainEntry }
  | { type: 'tool'; key: string; tool: ToolEntry; result?: ResultEntry }
  | { type: 'orphan'; key: string; result: ResultEntry };

export interface TerminalBatch {
  /** Itens novos, na ordem (ferramentas já trazem o resultado que chegou no mesmo lote). */
  added: TerminalItem[];
  /** Resultados de ferramentas que já estavam na tela. */
  attached: { toolKey: string; result: ResultEntry }[];
}

/** Chave estável de uma entrada (o tipo entra na chave: o id de um resultado pode repetir o da ferramenta). */
export function entryKey(e: Pick<TerminalEntry, 'kind' | 'id'>): string {
  return `${e.kind}:${e.id}`;
}

export function toolKey(toolUseId: string): string {
  return `tool:${toolUseId}`;
}

export function terminalUrl(agentId: string): string {
  return `/api/agents/${encodeURIComponent(agentId)}/terminal`;
}

/** Stream da conversa de uma sessão do histórico (mesmo protocolo do terminal do agente). */
export function sessionTerminalUrl(account: string, sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(account)}/${encodeURIComponent(sessionId)}/terminal`;
}

/** Chave de uma sessão do histórico aberta no painel (nunca coincide com o id de um agente). */
export function sessionKey(account: string, sessionId: string): string {
  return `session:${account}:${sessionId}`;
}

/** Nome curto do projeto de uma sessão: a última pasta do cwd (ou o nome codificado da pasta em projects/). */
export function sessionProjectName(s: Pick<RecentSession, 'project' | 'projectDir'>): string {
  const path = s.project?.replace(/[\\/]+$/, '');
  if (path) return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1) || path;
  return s.projectDir;
}

/** Rodapé de uma sessão encerrada: "Sessão encerrada às 14:30" (hoje), "… ontem às 14:30" ou "… em 06 de out. às 14:30". */
export function sessionEndedText(at: number, now: number): string {
  if (!Number.isFinite(at) || at <= 0) return tr('Sessão encerrada');
  const clock = formatClock(at, false);
  const diff = calendarDayDiff(at, now);
  if (diff === 0) return tr('Sessão encerrada às {0}', [clock]);
  if (diff === -1) return tr('Sessão encerrada ontem às {0}', [clock]);
  return tr('Sessão encerrada em {0} às {1}', [dayFmt.format(at), clock]);
}

/**
 * A conversa em memória: deduplica por id, junta cada resultado à sua ferramenta pelo `toolUseId` e limita o total
 * de itens (os mais antigos saem). Não conhece o DOM: devolve o que mudou para a tela aplicar.
 */
export class TerminalLog {
  /** Itens na ordem de chegada (o Map preserva a ordem de inserção: o primeiro é o mais antigo). */
  private items = new Map<string, TerminalItem>();
  /** Chaves de entradas já vistas (inclui os resultados juntados às ferramentas). */
  private seen = new Set<string>();

  get size(): number {
    return this.items.size;
  }

  /** Itens na ordem da tela (do mais antigo para o mais recente). */
  values(): IterableIterator<TerminalItem> {
    return this.items.values();
  }

  get(key: string): TerminalItem | undefined {
    return this.items.get(key);
  }

  reset(): void {
    this.items.clear();
    this.seen.clear();
  }

  push(entries: readonly TerminalEntry[]): TerminalBatch {
    const added: TerminalItem[] = [];
    const attached: TerminalBatch['attached'] = [];
    const fresh = new Set<string>();
    for (const e of entries) {
      const key = entryKey(e);
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      if (e.kind === 'tool') {
        const item: TerminalItem = { type: 'tool', key, tool: e };
        this.items.set(key, item);
        added.push(item);
        fresh.add(key);
      } else if (e.kind === 'result') {
        const tk = toolKey(e.toolUseId);
        const tool = this.items.get(tk);
        if (tool?.type === 'tool' && !tool.result) {
          tool.result = e;
          // Ferramenta deste mesmo lote: o resultado já sai junto; senão, vira uma atualização da linha existente.
          if (!fresh.has(tk)) attached.push({ toolKey: tk, result: e });
        } else {
          // Ferramenta fora da janela (ou resultado repetido): aparece sozinho.
          const item: TerminalItem = { type: 'orphan', key, result: e };
          this.items.set(key, item);
          added.push(item);
        }
      } else {
        const item: TerminalItem = { type: 'entry', key, entry: e };
        this.items.set(key, item);
        added.push(item);
      }
    }
    return { added, attached };
  }

  /**
   * Conversa mais antiga que a já carregada, entrando no começo. Resultados que estavam sozinhos (a ferramenta era anterior à
   * janela) são juntados à ferramenta que acabou de chegar, e a linha solta some (`removed`). `added` vem na ordem da tela.
   */
  prepend(entries: readonly TerminalEntry[]): { added: TerminalItem[]; removed: string[] } {
    const added: TerminalItem[] = [];
    const removed: string[] = [];
    const orphans = new Map<string, string>();
    for (const [key, item] of this.items) if (item.type === 'orphan') orphans.set(toolKey(item.result.toolUseId), key);
    const tools = new Map<string, Extract<TerminalItem, { type: 'tool' }>>();
    for (const e of entries) {
      const key = entryKey(e);
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      if (e.kind === 'tool') {
        const item: Extract<TerminalItem, { type: 'tool' }> = { type: 'tool', key, tool: e };
        const orphanKey = orphans.get(key);
        const orphan = orphanKey === undefined ? undefined : this.items.get(orphanKey);
        if (orphanKey !== undefined && orphan?.type === 'orphan') {
          item.result = orphan.result;
          this.items.delete(orphanKey);
          removed.push(orphanKey);
        }
        tools.set(key, item);
        added.push(item);
      } else if (e.kind === 'result') {
        const tool = tools.get(toolKey(e.toolUseId));
        if (tool && !tool.result) tool.result = e;
        else added.push({ type: 'orphan', key, result: e });
      } else {
        added.push({ type: 'entry', key, entry: e });
      }
    }
    this.items = new Map<string, TerminalItem>([...added.map((i): [string, TerminalItem] => [i.key, i]), ...this.items]);
    return { added, removed };
  }

  /** Descarta os itens mais antigos até sobrar `limit`; devolve as chaves removidas. */
  trim(limit: number): string[] {
    const removed: string[] = [];
    for (const [key, item] of this.items) {
      if (this.items.size <= limit) break;
      this.items.delete(key);
      this.seen.delete(key);
      if (item.type === 'tool' && item.result) this.seen.delete(entryKey(item.result));
      removed.push(key);
    }
    return removed;
  }
}

const KINDS = new Set<TerminalEntry['kind']>(['user', 'assistant', 'thinking', 'tool', 'result', 'system']);

function validEntry(raw: unknown): raw is TerminalEntry {
  if (!raw || typeof raw !== 'object') return false;
  const e = raw as Record<string, unknown>;
  if (typeof e.id !== 'string' || !KINDS.has(e.kind as TerminalEntry['kind'])) return false;
  switch (e.kind) {
    case 'thinking':
      return e.text === undefined || typeof e.text === 'string';
    case 'tool':
      return typeof e.title === 'string';
    case 'result':
      return typeof e.toolUseId === 'string' && typeof e.text === 'string';
    default:
      return typeof e.text === 'string';
  }
}

/** Entradas válidas de um `append` (ou da lista do `init`); o resto é ignorado. */
export function sanitizeEntries(raw: unknown): TerminalEntry[] {
  return Array.isArray(raw) ? raw.filter(validEntry) : [];
}

function parseJson(data: unknown): unknown {
  if (typeof data !== 'string') return undefined;
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

/** Dados do evento `init`; null se não forem reconhecíveis. */
export function parseInit(data: unknown): TerminalInit | null {
  const obj = parseJson(data);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  const earlier = typeof o.earlier === 'number' && Number.isFinite(o.earlier) && o.earlier > 0 ? o.earlier : undefined;
  return { agentId: typeof o.agentId === 'string' ? o.agentId : '', entries: sanitizeEntries(o.entries), truncated: o.truncated === true, ...(earlier === undefined ? {} : { earlier }) };
}

/** Dados do evento `append`. */
export function parseAppend(data: unknown): TerminalEntry[] {
  return sanitizeEntries(parseJson(data));
}

export interface TextPreview {
  /** Texto completo (sem espaços/linhas em branco no fim). */
  text: string;
  /** O que aparece recolhido. */
  head: string;
  /** Há mais do que a prévia mostra. */
  collapsed: boolean;
  /** Linhas escondidas na prévia (0 quando o corte foi no meio de uma linha comprida). */
  hiddenLines: number;
  total: number;
}

/** Onde cortar a prévia: o texto recolhido é `text.slice(0, headEnd)` (mais "…" quando `ellipsis`). */
export interface PreviewSplit {
  text: string;
  headEnd: number;
  /** O corte foi no meio de uma linha comprida (e não numa quebra de linha). */
  ellipsis: boolean;
  collapsed: boolean;
  hiddenLines: number;
  total: number;
}

/**
 * Prévia recolhida de um texto longo: as primeiras `maxLines` linhas (e no máximo `maxChars` caracteres).
 * Só recolhe se sobrarem ao menos 3 linhas (esconder 1 ou 2 linhas atrás de um clique não compensa).
 */
export function splitPreview(raw: string, maxLines: number, maxChars = maxLines * 200): PreviewSplit {
  const text = raw.replace(/\s+$/, '');
  const lines = text === '' ? [] : text.split('\n');
  const total = lines.length;
  if (total <= maxLines + 2 && text.length <= maxChars) return { text, headEnd: text.length, ellipsis: false, collapsed: false, hiddenLines: 0, total };
  let shown = Math.min(total, maxLines);
  let headEnd = lines.slice(0, shown).join('\n').length;
  let ellipsis = false;
  if (headEnd > maxChars) {
    headEnd = text.slice(0, maxChars).replace(/\s+$/, '').length;
    ellipsis = true;
    shown = text.slice(0, headEnd).split('\n').length;
  }
  return { text, headEnd, ellipsis, collapsed: true, hiddenLines: Math.max(0, total - shown), total };
}

/** A mesma prévia como texto (o que aparece recolhido em `head`). */
export function previewText(raw: string, maxLines: number, maxChars = maxLines * 200): TextPreview {
  const p = splitPreview(raw, maxLines, maxChars);
  const head = p.collapsed ? `${p.text.slice(0, p.headEnd)}${p.ellipsis ? '…' : ''}` : p.text;
  return { text: p.text, head, collapsed: p.collapsed, hiddenLines: p.hiddenLines, total: p.total };
}

/** Rótulo do botão que expande: "… +12 linhas" (ou "… mostrar tudo" quando o corte foi numa linha comprida). */
export function moreLabel(hiddenLines: number): string {
  if (hiddenLines <= 0) return tr('… mostrar tudo');
  return `… +${hiddenLines} ${hiddenLines === 1 ? tr('linha') : tr('linhas')}`;
}

/** "Bash(npm test)" -> nome em destaque + argumentos, como o Claude Code mostra. */
export function splitToolTitle(title: string): { name: string; args: string } {
  const i = title.indexOf('(');
  if (i > 0 && title.endsWith(')') && !/\s/.test(title.slice(0, i))) return { name: title.slice(0, i), args: title.slice(i) };
  return { name: title, args: '' };
}

/** Mostra o `input` da ferramenta? Um comando que já cabe inteiro no título não se repete embaixo. */
export function showToolInput(tool: Pick<ToolEntry, 'title' | 'input' | 'inputKind'>): boolean {
  const input = tool.input?.trim();
  if (!input) return false;
  if ((tool.inputKind ?? 'text') === 'command' && !input.includes('\n') && tool.title.includes(input)) return false;
  return true;
}

export type DiffLineKind = 'add' | 'del' | 'hunk' | 'ctx';

export function diffLineKind(line: string): DiffLineKind {
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  if (line.startsWith('@@')) return 'hunk';
  return 'ctx';
}

/** Horário da entrada para a dica: "14:30:05" hoje, "06 de out., 14:30" em outro dia. */
export function entryTimeTitle(at: number, now: number): string {
  if (!Number.isFinite(at) || at <= 0) return '';
  return calendarDayDiff(at, now) === 0 ? formatClock(at) : formatDateTime(at);
}

/** Quadros do spinner do rodapé de cada ferramenta. */
export function spinnerFrames(provider: Provider): readonly string[] {
  return provider === 'codex' ? CODEX_SPINNER : SPINNER;
}

/** Símbolo parado do rodapé (sem animação, ou fora do "trabalhando"). */
export function footerGlyph(kind: TerminalFooterKind, provider: Provider): string {
  if (kind === 'working') return provider === 'codex' ? '•' : '✻';
  return { waiting: '✋', shell: '⏳', idle: '○', ended: '■' }[kind];
}

export type TerminalFooterKind = 'working' | 'waiting' | 'shell' | 'idle' | 'ended';

export interface TerminalFooter {
  kind: TerminalFooterKind;
  text: string;
  /** Desde quando está nesse estado (para o tempo ao lado do texto). */
  since?: number;
}

/** Linha de estado do rodapé, imitando o Claude Code, a partir do agente vivo no snapshot. */
/** `compacting`: o terminal do agente está compactando a conversa (PtyInfo.compacting): o transcript não diz isso, e sem ele o rodapé ficaria em "Pensando…". */
export function terminalFooter(agent: AgentInfo | undefined, agents: readonly AgentInfo[], now: number, compacting = false): TerminalFooter {
  if (!agent || agent.status === 'offline') return { kind: 'ended', text: tr('Sessão encerrada') };
  if (agent.status === 'done') return { kind: 'ended', text: tr('Subagente concluído · sessão encerrada') };
  const wait = shellWaitIn(agent, agents, now);
  if (wait) {
    const label = wait.main?.label?.trim();
    const more = wait.jobs.length > 1 ? ` (+${wait.jobs.length - 1})` : '';
    return { kind: 'shell', text: label ? tr('Esperando o shell: {0}{1}', [label, more]) : tr('Esperando o shell terminar'), since: wait.since };
  }
  if (compacting && agent.status === 'working') return { kind: 'working', text: tr('Compactando a conversa…'), since: agent.statusSince };
  switch (agent.status) {
    case 'working': {
      const act = agent.activity?.text?.trim().replace(/(?:…|\.{1,3})$/, '');
      return { kind: 'working', text: `${act || tr('Trabalhando')}…`, since: agent.statusSince };
    }
    case 'waiting': {
      const text = agent.waitingFor ? tr('Esperando você: {0}', [agent.waitingFor]) : tr('Esperando você');
      if (agent.permission) return { kind: 'waiting', text, since: agent.statusSince };
      // Sem o pedido no Habblaud (o hook já devolveu à sessão, a sessão abriu sem o plugin ou não havia página aberta
      // quando ele chegou): os botões não vêm, então diz onde responder.
      const hint =
        agent.provider === 'codex'
          ? tr('{0} · responda no Codex: este pedido não chegou ao Habblaud ou passou do tempo de espera', [text])
          : tr('{0} · responda no Claude Code: este pedido não chegou ao Habblaud ou passou do tempo de espera', [text]);
      return { kind: 'waiting', text: hint, since: agent.statusSince };
    }
    default:
      return { kind: 'idle', text: tr('Aguardando o próximo prompt') };
  }
}

// ---------------------------------------------------------------- linhas (DOM)

type Fill = (target: HTMLElement, text: string) => void;

/** Cria o botão de copiar de uma entrada (`what` = "prompt", "resposta", "comando", "resultado"...). */
type Copier = (text: string, what: string) => HTMLElement;

const fillPlain: Fill = (target, text) => {
  target.textContent = text;
};

/** Diff: uma linha por elemento, com fundo verde (+) ou vermelho (-), como no Claude Code. */
const fillDiff: Fill = (target, text) => {
  const frag = document.createDocumentFragment();
  for (const line of text.split('\n')) frag.append(h('span', { class: `ui-term__dl is-${diffLineKind(line)}`, text: line || ' ' }));
  target.append(frag);
};

/** Blocos que a busca abre ao chegar num resultado escondido neles (prévias recolhidas, raciocínio, detalhes). */
const expandables = new WeakMap<Element, () => void>();

/** Abre os blocos recolhidos que escondem `el` dentro de `stop` (ex.: um resultado da busca no "… +N linhas"). */
function revealWithin(el: Element, stop: Element): void {
  let hidden = false;
  for (let n: Element | null = el; n && n !== stop; n = n.parentElement) {
    if ((n as HTMLElement).hidden) hidden = true;
    const open = expandables.get(n);
    // Só abre quem esconde o trecho (um resultado já visível na prévia não expande o bloco).
    if (open && hidden) {
      open();
      hidden = false;
    }
  }
}

/**
 * Bloco de texto que recolhe quando é longo, com "… +N linhas" para expandir (e "recolher" depois). O texto inteiro
 * fica no DOM (o resto escondido), para a busca achar e destacar o que está recolhido.
 */
function collapsible(raw: string, maxLines: number, cls: string, fill: Fill = fillPlain): HTMLElement {
  const p = splitPreview(raw, maxLines);
  const body = h('div', { class: 'ui-term__pre' });
  const box = h('div', { class: cls }, body);
  if (!p.collapsed) {
    fill(body, p.text);
    return box;
  }
  // Diff: uma linha por elemento (blocos); o resto começa na linha seguinte.
  const block = fill === fillDiff;
  const head = h(block ? 'div' : 'span', {});
  fill(head, p.text.slice(0, p.headEnd));
  const rest = h(block ? 'div' : 'span', { hidden: true });
  fill(rest, block ? p.text.slice(p.headEnd).replace(/^\n/, '') : p.text.slice(p.headEnd));
  const dots = p.ellipsis ? h('span', { class: 'ui-term__dots', text: '…', attrs: { 'aria-hidden': 'true' } }) : null;
  body.append(head, ...(dots ? [dots] : []), rest);
  let open = false;
  const more = h('button', { class: 'ui-term__more', type: 'button', attrs: { 'aria-expanded': 'false' } });
  const set = (v: boolean) => {
    open = v;
    rest.hidden = !open;
    if (dots) dots.hidden = open;
    setText(more, open ? tr('recolher') : moreLabel(p.hiddenLines));
    setAttr(more, 'aria-expanded', String(open));
    setTitle(more, open ? tr('Recolher') : tr('Mostrar tudo ({0} {1})', [p.total, p.total === 1 ? tr('linha') : tr('linhas')]));
  };
  set(false);
  more.addEventListener('click', () => set(!open));
  expandables.set(box, () => {
    if (!open) set(true);
  });
  box.append(more);
  return box;
}

/** Texto que expande num clique (raciocínio, detalhe de evento). */
function expander(label: string, cls: string, detail: string, detailCls: string): HTMLElement {
  const body = h('div', { class: detailCls, text: detail, hidden: true });
  const btn = h('button', { class: cls, type: 'button', text: label, attrs: { 'aria-expanded': 'false' } });
  let open = false;
  const set = (v: boolean) => {
    open = v;
    body.hidden = !open;
    setAttr(btn, 'aria-expanded', String(open));
  };
  btn.addEventListener('click', () => set(!open));
  const wrap = h('div', { class: 'ui-term__exp' }, btn, body);
  expandables.set(wrap, () => set(true));
  return wrap;
}

const IMAGE_ID = /^[a-f0-9]{8,64}$/;
const IMAGE_RETRIES = 4;

/** Miniaturas das imagens que o agente citou ou gravou; um toque abre a imagem grande. */
function imageStrip(images: TerminalImage[] | undefined): HTMLElement | null {
  const ok = (images ?? []).filter((i) => i && IMAGE_ID.test(i.id) && typeof i.name === 'string').slice(0, 6);
  if (!ok.length) return null;
  const strip = h('div', { class: 'ui-term__imgs' });
  for (const i of ok) {
    const url = `/api/chat-image/${i.id}`;
    const img = h('img', { class: 'ui-term__img', attrs: { src: url, alt: i.name, loading: 'lazy', decoding: 'async' } });
    // A chamada da ferramenta chega ao chat antes de o arquivo existir: tenta de novo algumas vezes antes de desistir.
    let tries = 0;
    const btn = h('button', { class: 'ui-term__img-btn', attrs: { type: 'button', title: i.name, 'aria-label': tr('Ver a imagem {0}', [i.name]) } }, img);
    btn.addEventListener('click', () => openImage(url, i.name));
    // Arquivo que sumiu ou mudou de lugar: tira a miniatura quebrada.
    img.addEventListener('error', () => {
      if (tries >= IMAGE_RETRIES) return btn.remove();
      tries++;
      setTimeout(() => img.setAttribute('src', `${url}?r=${tries}`), 1_000 * tries);
    });
    strip.append(btn);
  }
  return strip;
}

/** Páginas HTML que o agente publicou (Artifact): um quadro isolado (sem scripts), carregado só ao abrir. */
function previewCards(pages: TerminalImage[] | undefined): HTMLElement | null {
  const ok = (pages ?? []).filter((i) => i && IMAGE_ID.test(i.id) && typeof i.name === 'string').slice(0, 3);
  if (!ok.length) return null;
  const wrap = h('div', { class: 'ui-term__previews' });
  for (const p of ok) {
    const url = `/api/chat-image/${p.id}`;
    const btn = h('button', { class: 'ui-term__preview-btn', text: tr('Ver a prévia: {0}', [p.name]), attrs: { type: 'button', 'aria-expanded': 'false' } });
    const open = h('a', { class: 'ui-term__preview-open', text: tr('Abrir em outra aba'), attrs: { href: url, target: '_blank', rel: 'noopener' } });
    const box = h('div', { class: 'ui-term__preview' }, btn, open);
    let frame: HTMLIFrameElement | undefined;
    btn.addEventListener('click', () => {
      if (frame) {
        frame.remove();
        frame = undefined;
        btn.setAttribute('aria-expanded', 'false');
        return;
      }
      frame = h('iframe', { class: 'ui-term__preview-frame', attrs: { src: url, title: p.name, sandbox: '', loading: 'lazy' } });
      box.append(frame);
      btn.setAttribute('aria-expanded', 'true');
    });
    wrap.append(box);
  }
  return wrap;
}

const ARTIFACT_URL = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9-]+/g;

/** Cartão "Abrir artefato" para cada link de artefato do claude.ai na resposta (a página é externa: abre em outra aba). */
function artifactLinks(text: string): HTMLElement | null {
  const urls = [...new Set(text.match(ARTIFACT_URL) ?? [])].slice(0, 3);
  if (!urls.length) return null;
  const wrap = h('div', { class: 'ui-term__artifacts' });
  for (const u of urls) wrap.append(h('a', { class: 'ui-term__artifact', text: `${tr('Abrir artefato')} ↗`, attrs: { href: u, target: '_blank', rel: 'noopener noreferrer', title: u } }));
  return wrap;
}

let imageDialog: HTMLDialogElement | undefined;

function openImage(url: string, name: string): void {
  if (!imageDialog) {
    const d = h('dialog', { class: 'ui-term__lightbox' });
    d.addEventListener('click', () => d.close());
    document.body.append(d);
    imageDialog = d;
  }
  const img = h('img', { class: 'ui-term__lightbox-img', attrs: { src: url, alt: name } });
  imageDialog.replaceChildren(img, h('a', { class: 'ui-term__lightbox-open', text: tr('Abrir em outra aba'), attrs: { href: url, target: '_blank', rel: 'noopener' } }));
  if (!imageDialog.open) imageDialog.showModal();
}

function mark(text: string, extra = ''): HTMLElement {
  return h('span', { class: `ui-term__mark ${extra}`.trim(), text, attrs: { 'aria-hidden': 'true' } });
}

function row(kind: string, at: number, now: number, ...children: (Node | null)[]): HTMLElement {
  return h('div', { class: `ui-term__row ui-term__row--${kind}`, title: entryTimeTitle(at, now), attrs: { 'data-at': String(at) } }, ...children);
}

/** "  ⎿  resultado" (primeiras linhas, "… +N linhas", o aviso de corte e o botão de copiar). */
function resultBlock(r: ResultEntry, copy: Copier): HTMLElement {
  const out = h('div', { class: 'ui-term__out' });
  const text = r.text.replace(/\s+$/, '');
  if (text) out.append(collapsible(text, RESULT_PREVIEW_LINES, 'ui-term__res-text'));
  else out.append(h('span', { class: 'ui-term__empty', text: r.error ? tr('(erro sem mensagem)') : tr('(sem saída)'), attrs: { 'data-chrome': '' } }));
  if (r.truncated) out.append(h('span', { class: 'ui-term__cut', text: tr('(resultado cortado)'), attrs: { 'data-chrome': '' } }));
  const el = h('div', { class: `ui-term__result${r.error ? ' is-error' : ''}` }, h('span', { class: 'ui-term__elbow', text: '⎿', attrs: { 'aria-hidden': 'true' } }), out);
  if (text) el.append(copy(copyTextOf(r), tr('resultado')));
  return el;
}

function toolInput(t: ToolEntry): HTMLElement | null {
  if (!showToolInput(t)) return null;
  const kind = t.inputKind ?? 'text';
  const input = t.input!.replace(/\s+$/, '');
  if (kind === 'diff') return collapsible(input, INPUT_PREVIEW_LINES, 'ui-term__in ui-term__in--diff', fillDiff);
  if (kind === 'command') {
    const box = collapsible(input, INPUT_PREVIEW_LINES, 'ui-term__in ui-term__in--command');
    box.prepend(h('span', { class: 'ui-term__dollar', text: '$', attrs: { 'aria-hidden': 'true' } }));
    return box;
  }
  return collapsible(input, INPUT_PREVIEW_LINES, `ui-term__in ui-term__in--${kind === 'json' ? 'json' : 'text'}`);
}

interface ToolRefs {
  row: HTMLElement;
  slot: HTMLElement;
  /** Cartão de pergunta: quem desenha a resposta no lugar do bloco de resultado. */
  fill?: (r: ResultEntry) => void;
}

/**
 * A pergunta do agente (AskUserQuestion) como um cartão: a pergunta, as opções e, quando você responde, a sua resposta
 * (com a opção escolhida em destaque). Sem isso saía o bloco bruto da ferramenta, com o texto repetido e o formato
 * interno do Claude Code. Devolve undefined se a entrada não traz as perguntas (cai no desenho padrão).
 */
function askRow(t: ToolEntry, now: number): ToolRefs | undefined {
  const questions: AskQuestion[] = parseAskInput(t.input);
  if (!questions.length) return undefined;
  const cards = questions.map((q) => {
    const opts = q.options.map((o) => h('li', { class: 'ui-term__q-opt' }, h('strong', { text: o.label }), o.desc ? h('span', { class: 'ui-term__q-desc', text: o.desc }) : null));
    // A resposta de cada pergunta aparece logo abaixo dela (com várias, "Você respondeu (1)" lá embaixo não dizia de qual).
    const reply = h('div', { class: 'ui-term__q-reply-slot' });
    const card = h('div', { class: 'ui-term__q' }, h('p', { class: 'ui-term__q-text', text: q.question }), opts.length ? h('ul', { class: 'ui-term__q-opts' }, ...opts) : null, reply);
    return { q, opts, card, reply };
  });
  const slot = h('div', { class: 'ui-term__q-reply-slot' }, h('span', { class: 'ui-term__q-wait', text: tr('Aguardando a sua resposta…'), attrs: { 'data-chrome': '' } }));
  const col = h('div', { class: 'ui-term__col ui-term__q-col' }, h('div', { class: 'ui-term__q-tag', text: tr('Pergunta do agente'), attrs: { 'data-chrome': '' } }), ...cards.map((c) => c.card), slot);
  const el = row('ask', t.at, now, mark('?', 'ui-term__qmark'), col);
  el.classList.add('is-pending');
  const fill = (r: ResultEntry) => {
    const parsed = parseAskAnswers(r.text);
    for (const c of cards) {
      // Cada pergunta pelo texto dela; com uma só, o texto inteiro serve quando o formato não bate.
      const answer = parsed.byQuestion.get(c.q.question) ?? (cards.length === 1 ? parsed.text : '');
      const chosen = chosenLabels(answer, c.q.options);
      c.opts.forEach((li, k) => li.classList.toggle('is-chosen', chosen.has(c.q.options[k].label)));
      c.reply.replaceChildren(
        ...(answer
          ? [
              h('div', { class: 'ui-term__q-reply' }, h('span', { class: 'ui-term__q-reply-tag', text: r.error ? tr('Sem resposta') : tr('Você respondeu'), attrs: { 'data-chrome': '' } }), h('span', { class: 'ui-term__q-reply-text', text: answer })),
            ]
          : []),
      );
    }
    slot.replaceChildren();
  };
  return { row: el, slot, fill };
}

function toolRow(t: ToolEntry, now: number, copy: Copier): ToolRefs {
  if (t.tool === 'AskUserQuestion') {
    const ask = askRow(t, now);
    if (ask) return ask;
  }
  const { name, args } = splitToolTitle(t.title);
  const title = h('div', { class: 'ui-term__title' }, h('strong', { text: name }), args ? document.createTextNode(args) : null);
  const input = toolInput(t);
  // Título + argumentos com o próprio botão de copiar (o comando; sem argumentos, o título).
  const what = t.inputKind === 'command' || t.tool === 'Bash' ? tr('comando') : input ? tr('entrada da ferramenta') : tr('ferramenta');
  const call = h('div', { class: 'ui-term__call' }, title, input, copy(copyTextOf(t), what));
  const slot = h('div', { class: 'ui-term__slot' });
  const el = row('tool', t.at, now, mark(DOT, 'ui-term__dot'), h('div', { class: 'ui-term__col' }, call, imageStrip(t.images), previewCards(t.previews), slot));
  el.classList.add('is-pending');
  return { row: el, slot };
}

function attachResult(refs: ToolRefs, r: ResultEntry, copy: Copier): void {
  refs.row.classList.remove('is-pending');
  refs.row.classList.toggle('is-error', !!r.error);
  refs.row.classList.toggle('is-ok', !r.error);
  if (refs.fill) refs.fill(r);
  else refs.slot.replaceChildren(resultBlock(r, copy));
}

function entryRow(e: PlainEntry, now: number, copy: Copier): HTMLElement {
  switch (e.kind) {
    case 'user': {
      const col = h('div', { class: 'ui-term__col' }, collapsible(e.text, PROMPT_PREVIEW_LINES, 'ui-term__user-text'));
      const el = row('user', e.at, now, mark('>'), col);
      // Modo de usuários: degradê leve na cor de quem escreveu e o nome acima do texto.
      if (e.by && /^#[0-9a-f]{6}$/i.test(e.by.color)) {
        el.classList.add('has-by');
        el.style.setProperty('--by', e.by.color);
        col.prepend(h('div', { class: 'ui-term__by', text: e.by.name, attrs: { 'data-chrome': '' } }));
      }
      el.append(copy(copyTextOf(e), 'prompt'));
      return el;
    }
    case 'assistant': {
      const body = h('div', { class: 'ui-term__col ui-md' });
      body.append(renderMarkdown(e.text));
      markDocPaths(body);
      const pics = imageStrip(e.images);
      if (pics) body.append(pics);
      const links = artifactLinks(e.text);
      if (links) body.append(links);
      const el = row('assistant', e.at, now, mark(DOT, 'ui-term__dot'), body);
      el.append(copy(copyTextOf(e), tr('resposta')));
      return el;
    }
    case 'thinking': {
      const text = e.text?.trim();
      const content = text ? expander(tr('Pensando…'), 'ui-term__think', text, 'ui-term__think-text') : h('span', { class: 'ui-term__think', text: tr('Pensando…'), attrs: { 'data-chrome': '' } });
      return row('thinking', e.at, now, mark('✻'), h('div', { class: 'ui-term__col' }, content));
    }
    case 'system': {
      const text = h('span', { class: 'ui-term__sys-text', text: e.text });
      const col = h('div', { class: 'ui-term__col' }, text);
      if (e.detail?.trim()) col.append(expander(tr('detalhes'), 'ui-term__sys-more', e.detail.trim(), 'ui-term__sys-detail'));
      const el = row('system', e.at, now, mark('※'), col);
      if (e.level === 'warn' || e.level === 'error') el.classList.add(`is-${e.level}`);
      return el;
    }
  }
}

// ---------------------------------------------------------------- janela

/** O que o resto da interface (gaveta, atalhos, histórico) usa do terminal. */
export interface TerminalControl {
  /** Agente com o terminal aberto (null = fechado ou mostrando uma sessão do histórico). */
  readonly agentId: string | null;
  open(agentId: string, opener?: HTMLElement | null): void;
  /** Abre uma sessão do histórico: a conversa do transcript ou, se ela ainda estiver aberta, o terminal ao vivo do agente. */
  openSession(session: RecentSession, opener?: HTMLElement | null): void;
  close(): void;
  toggle(agentId: string, opener?: HTMLElement | null): void;
}

type ConnState = 'connecting' | 'open' | 'reconnecting' | 'failed';

/** Resultado atual da busca: o `index`-ésimo destaque da linha `key`. */
interface SearchRef {
  key: string;
  index: number;
}

const NO_FINALS: ReadonlySet<string> = new Set();

export class TerminalPanel implements UiComponent, TerminalControl {
  readonly el: HTMLElement;
  private id: string | null = null;
  /** Sessão do histórico aberta no painel (null = terminal de um agente). */
  private session: RecentSession | null = null;
  private last: AgentInfo | null = null;
  private source: EventSource | null = null;
  private opener: HTMLElement | null = null;
  private conn: ConnState = 'connecting';
  /** Já recebeu um `init` desta conexão (ou de uma anterior, no mesmo agente). */
  private loaded = false;
  private truncated = false;
  /** Byte de onde pedir a conversa anterior (0 = não há mais); vem do `init` e anda para trás a cada página. */
  private earlier = 0;
  private loadingEarlier = false;
  /** Quantos itens a tela mantém ao chegar mensagem nova: sobe quando o usuário carrega conversa anterior (senão a que ele pediu sairia). */
  private keep = 0;
  private log = new TerminalLog();
  private rows = new Map<string, HTMLElement>();
  private undoBtn: HTMLButtonElement | null = null;
  private undoBusy = false;
  private tools = new Map<string, ToolRefs>();
  /** Grudado no fim: mensagens novas rolam a tela. */
  private follow = true;
  /** Itens que chegaram enquanto o usuário lia lá em cima. */
  private unread = 0;
  private spinTimer: ReturnType<typeof setInterval> | null = null;
  private spinFrame = 0;
  /** Horário da entrada mais recente (o rodapé de uma sessão retomada acompanha). */
  private lastEntryAt = 0;

  /** Quem mais está com este agente aberto (modo de usuários). */
  private readonly presence: ReturnType<typeof presenceStrip>;

  private filter: TerminalFilter = DEFAULT_TERMINAL_FILTER;
  private filterBtns: HTMLButtonElement[] = [];
  /** Linhas que aparecem com o filtro atual. */
  private visibleRows = 0;

  private searchOpen = false;
  /** Termo da busca já dobrado (minúsculas, sem acentos); '' = sem busca. */
  private folded = '';
  /** Destaques de cada linha (inclusive as escondidas pelo filtro, que não entram na contagem). */
  private hits = new Map<string, HTMLElement[]>();
  private current: SearchRef | null = null;
  private currentEl: HTMLElement | null = null;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  private kindEl: HTMLElement;
  private accEl: HTMLElement;
  private nameEl: HTMLElement;
  /** Selo "Codex" (sessão do Codex). */
  private provEl: HTMLElement;
  /** Quadros do spinner da sessão aberta (Claude Code ou Codex). */
  private frames: readonly string[] = SPINNER;
  private roleEl: HTMLElement;
  private roomEl: HTMLElement;
  private barEl!: HTMLElement;
  private chips: SessionChips;
  private reconnEl: HTMLElement;
  private findBtn: HTMLButtonElement;
  private alertEl: HTMLElement;
  private alertText: HTMLElement;
  private searchBox: HTMLElement;
  private searchInput: HTMLInputElement;
  private countEl: HTMLElement;
  private scroll: HTMLElement;
  private list: HTMLElement;
  private note: HTMLElement;
  private earlierBtn: HTMLButtonElement;
  private placeholder: HTMLElement;
  private newBtn: HTMLButtonElement;
  private status: HTMLElement;
  private glyph: HTMLElement;
  private statusText: HTMLElement;
  private statusTime: HTMLElement;
  /** "Assumir daqui" e "Encerrar" (terminal interativo ligado) e as abas dos agentes do projeto. */
  private actions: TermActions | null;
  private tabs: TermTabs;
  private movable: Movable;
  /** Caixa de mensagem do rodapé (só a sessão ao vivo de um agente principal). */
  private composer: MessageComposer;
  /** Pergunta ou pedido de permissão do agente (o mesmo cartão da gaveta: dá para responder daqui). */
  private perm: PermissionCard;
  /** Pergunta que o escritório não consegue responder (sem o plugin): só para ler, com o aviso de como ligar. */
  private askBox: HTMLElement;
  private askWait: HTMLElement;
  private askOpen: HTMLButtonElement;
  private askHint: HTMLElement;
  private askList: HTMLElement;
  private askKey = '';

  constructor(
    private ctx: UiContext,
    pty?: PtyControl,
    opts: WindowOptions = {},
  ) {
    this.actions = pty ? new TermActions(ctx, pty, true) : null;
    this.perm = new PermissionCard(ctx);
    this.askList = h('div', { class: 'ui-ask' });
    this.askWait = h('p', { class: 'ui-term__ask-wait' });
    // O pedido que o Habblaud soltou (ou que não chegou) segue esperando no terminal da sessão: se esse terminal é o
    // interativo daqui, o botão leva até ele.
    this.askOpen = h('button', {
      class: 'ui-btn ui-btn--sm ui-btn--accent',
      type: 'button',
      hidden: true,
      on: { click: () => this.id !== null && this.ctx.terminals?.showInteractive(this.id) },
    }, tr('Abrir o terminal para responder'));
    this.askHint = h('p', { class: 'ui-ask__answer-hint', text: tr('Com o plugin habblaud-permissoes (npm run mod:install), dá para responder as perguntas por aqui.') });
    this.askBox = h('section', { class: 'ui-term__ask', role: 'alert', hidden: true }, h('strong', { text: tr('Precisa de você') }), this.askWait, this.askList, this.askOpen, this.askHint);
    this.tabs = new TermTabs(ctx, opts.openAgent);
    const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
    const findKey = mac ? '⌘F' : 'Ctrl+F';
    const icon = h('span', { class: 'ui-term__icon', attrs: { 'aria-hidden': 'true' } });
    icon.innerHTML = ICONS.terminal;
    this.kindEl = h('span', { class: 'ui-term__kind', text: 'terminal' });
    this.accEl = createAccountChip('sm');
    this.accEl.hidden = true;
    this.nameEl = h('strong', { class: 'ui-term__name' });
    this.provEl = createProviderTag('ui-prov--xs');
    this.roleEl = h('span', { class: 'ui-role' });
    this.roomEl = h('span', { class: 'ui-term__room' });
    this.reconnEl = h('span', { class: 'ui-term__reconn', text: tr('reconectando…'), hidden: true, role: 'status' });
    this.findBtn = iconButton(ICONS.search, tr('Buscar na conversa ({0})', [findKey]), () => this.toggleSearch(), 'ui-icon-btn--sm ui-term__find');
    setAttr(this.findBtn, 'aria-expanded', 'false');
    const close = iconButton(ICONS.close, tr('Fechar terminal (Esc)'), () => this.close(), 'ui-icon-btn--sm ui-term__close');
    this.chips = new SessionChips(ctx);
    this.presence = presenceStrip();
    const bar = h(
      'div',
      { class: 'ui-term__bar' },
      icon,
      this.kindEl,
      h('div', { class: 'ui-term__who' }, this.accEl, this.nameEl, this.provEl, this.roleEl, this.roomEl),
      this.presence.el,
      this.reconnEl,
      this.chips.el,
      this.findBtn,
      ...(this.actions ? [this.actions.el] : []),
      layoutButton(() => this.movable),
      maximizeButton(() => this.movable),
      close,
    );
    this.barEl = bar;

    // Barra de ferramentas: filtro (segmentado) e a busca, que aparece com Ctrl/⌘+F ou a lupa.
    const filters = h('div', { class: 'ui-seg ui-term__filter', role: 'radiogroup', attrs: { 'aria-label': tr('Filtrar a conversa') } });
    for (const [value, text, hint] of TERMINAL_FILTERS) {
      const b = h('button', { class: 'ui-seg__opt', type: 'button', role: 'radio', text, title: hint, attrs: { 'aria-checked': 'false' } });
      b.addEventListener('click', () => this.setFilter(value));
      b.addEventListener('keydown', (e) => this.filterKey(e, value));
      this.filterBtns.push(b);
      filters.append(b);
    }
    const searchIcon = h('span', { class: 'ui-term__search-icon', attrs: { 'aria-hidden': 'true' } });
    searchIcon.innerHTML = ICONS.search;
    this.searchInput = h('input', {
      class: 'ui-term__search-input',
      type: 'text',
      attrs: { placeholder: tr('Buscar na conversa'), 'aria-label': tr('Buscar na conversa'), autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'search' },
    });
    this.searchInput.addEventListener('input', () => this.scheduleSearch());
    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.go(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.closeSearch(true);
      }
    });
    this.countEl = h('span', { class: 'ui-term__count', attrs: { 'aria-live': 'polite' } });
    this.searchBox = h(
      'div',
      { class: 'ui-term__search', role: 'search', hidden: true },
      searchIcon,
      this.searchInput,
      this.countEl,
      iconButton(ICONS.chevronUp, tr('Resultado anterior (Shift+Enter)'), () => this.go(-1), 'ui-icon-btn--sm ui-term__step'),
      iconButton(ICONS.chevronDown, tr('Próximo resultado (Enter)'), () => this.go(1), 'ui-icon-btn--sm ui-term__step'),
      iconButton(ICONS.close, tr('Fechar a busca (Esc)'), () => this.closeSearch(true), 'ui-icon-btn--sm ui-term__step'),
    );
    const tools = h('div', { class: 'ui-term__tools' }, filters, this.searchBox);

    const retry = h('button', { class: 'ui-btn ui-btn--sm', type: 'button', text: tr('Tentar de novo'), on: { click: () => this.connect() } });
    this.alertText = h('span', { class: 'ui-term__alert-text', text: OPEN_ERROR });
    this.alertEl = h('div', { class: 'ui-term__alert', role: 'alert', hidden: true }, this.alertText, retry);
    this.note = h('p', { class: 'ui-term__note', text: tr('Conversa anterior não carregada'), hidden: true });
    this.earlierBtn = h('button', { class: 'ui-term__earlier', type: 'button', text: tr('Carregar conversa anterior'), hidden: true, on: { click: () => void this.loadEarlier() } });
    this.list = h('div', { class: 'ui-term__list' });
    this.placeholder = h('p', { class: 'ui-term__placeholder' });
    this.scroll = h('div', { class: 'ui-term__scroll', tabIndex: 0, attrs: { 'aria-label': tr('Conversa da sessão') } }, this.note, this.earlierBtn, this.list, this.placeholder);
    this.scroll.addEventListener('scroll', () => this.onScroll(), { passive: true });
    // Caminho de .md citado na resposta: clique (ou Enter) abre o documento formatado.
    const openCited = (e: Event): void => {
      const code = (e.target as HTMLElement | null)?.closest<HTMLElement>('code[data-doc]');
      if (code?.dataset.doc) openDoc(this.projectPath(), code.dataset.doc);
    };
    this.scroll.addEventListener('click', openCited);
    this.scroll.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') openCited(e);
    });
    this.newBtn = h('button', { class: 'ui-term__new', type: 'button', hidden: true, on: { click: () => this.jumpToEnd() } });

    this.glyph = h('span', { class: 'ui-term__glyph', attrs: { 'aria-hidden': 'true' } });
    this.statusText = h('span', { class: 'ui-term__status-text' });
    this.statusTime = h('span', { class: 'ui-term__status-time' });
    this.status = h('p', { class: 'ui-term__status' }, this.glyph, this.statusText, this.statusTime);
    // Esc na caixa devolve o foco à conversa (o próximo fecha o terminal).
    this.composer = new MessageComposer(ctx, 'terminal', { onEscape: () => this.focusLog() });

    this.el = h(
      'section',
      { class: 'ui-term', role: 'dialog', hidden: true, tabIndex: -1, attrs: { 'aria-label': tr('Terminal') } },
      bar,
      this.tabs.el,
      tools,
      h('div', { class: 'ui-term__body' }, this.alertEl, this.scroll, this.newBtn),
      this.perm.el,
      this.askBox,
      h('div', { class: 'ui-term__foot' }, this.status, this.composer.el),
    );
    this.el.addEventListener('keydown', (e) => this.onKey(e));
    // Arrastar pela barra solta a janela (ui/movable.ts).
    this.movable = new Movable(this.el, bar, { key: opts.moveKey ?? 'habblaud.move.term', enabled: () => !ctx.isNarrow() });
    if (opts.offset) this.el.style.setProperty('--slot-off', `${opts.offset}px`);
    this.renderFilter();
    // Janela redimensionada: quem está no fim continua vendo o fim.
    if (typeof ResizeObserver === 'function') new ResizeObserver(() => this.follow && this.scrollToEnd()).observe(this.scroll);
  }

  get agentId(): string | null {
    return this.session ? null : this.id;
  }

  get isOpen(): boolean {
    return this.id !== null;
  }

  open(agentId: string, opener: HTMLElement | null = activeElement()): void {
    this.start(agentId, null, opener);
  }

  openSession(session: RecentSession, opener: HTMLElement | null = activeElement()): void {
    // Ainda aberta e no escritório: o terminal ao vivo do agente (com status no rodapé).
    if (session.open && session.agentId && this.ctx.agent(session.agentId)) return this.open(session.agentId, opener);
    this.start(sessionKey(session.account, session.sessionId), session, opener);
  }

  close(): void {
    if (this.id === null) return;
    this.disconnect();
    this.stopSpinner();
    this.closeSearch(false);
    this.chips.closeAll();
    const hadFocus = this.el.contains(document.activeElement) || document.activeElement === document.body;
    this.id = null;
    this.session = null;
    this.last = null;
    this.presence.set(null);
    this.el.hidden = true;
    this.clear();
    const opener = this.opener;
    this.opener = null;
    if (hadFocus && opener?.isConnected) opener.focus({ preventScroll: true });
    this.ctx.invalidate();
  }

  toggle(agentId: string, opener: HTMLElement | null = activeElement()): void {
    if (this.agentId === agentId) this.close();
    else this.open(agentId, opener);
  }

  /** Esc: o primeiro fecha a busca; o seguinte, o terminal. Devolve false se não havia nada aberto. */
  escape(): boolean {
    if (this.id === null) return false;
    if (this.searchOpen) this.closeSearch(this.el.contains(document.activeElement));
    else this.close();
    return true;
  }

  /**
   * Pergunta (AskUserQuestion) ou pedido de permissão do agente: o cartão que responde, igual ao da gaveta; sem o
   * pedido no escritório (plugin ausente), as perguntas aparecem só para ler. Antes, a conversa não mostrava nada
   * disso e só dava para responder no terminal de onde a sessão roda.
   */
  /** Pasta do projeto desta conversa (agente aberto ou sessão do histórico); vazia se não se sabe. */
  private projectPath(): string {
    if (this.session) return this.session.project ?? '';
    return this.last ? (this.ctx.store.room(this.last.roomId)?.path ?? '') : '';
  }

  private renderAsk(live: AgentInfo | null): void {
    this.perm.render(live ?? undefined);
    // Esperando você e sem o cartão (o pedido não chegou ao Habblaud, ou "Responder no terminal" o soltou): o diálogo
    // está no terminal da sessão. O aviso fica enquanto durar a espera e leva até esse terminal quando é o daqui.
    const waiting = !!live && live.provider !== 'codex' && live.status === 'waiting' && !this.perm.visible;
    setHidden(this.askBox, !waiting);
    if (!waiting || !live) {
      this.askKey = '';
      return;
    }
    setText(this.askWait, live.waitingFor ? tr('Esperando você: {0}', [live.waitingFor]) : tr('Esperando você'));
    const interactive = !!this.ctx.terminals?.interactive(live.id);
    setHidden(this.askOpen, !interactive);
    setHidden(this.askHint, interactive);
    const asking = live.activity?.kind === 'ask' ? live.activity : undefined;
    const qs = asking?.questions ?? [];
    setHidden(this.askList, qs.length === 0);
    const key = qs.length ? `${asking!.id}|${qs.length}` : '';
    if (key === this.askKey) return;
    this.askKey = key;
    this.askList.replaceChildren(...askQuestionNodes(qs));
  }

  render(): void {
    if (this.id === null) return;
    if (this.session) this.renderSessionHead(this.session);
    else this.renderAgentHead();
    this.presence.set(this.session ? null : this.id);
    const live = this.session ? null : (this.ctx.agent(this.id) ?? null);
    this.actions?.render(live, this.session && !this.session.open ? this.session : null);
    this.chips.render(live);
    this.tabs.render(live ? live.id : null);
    this.renderFooter();
    this.renderUndo(live);
    this.renderState();
    this.renderAsk(live);
    // Mensagens só para a sessão ao vivo (no histórico, a caixa diz que a sessão foi encerrada).
    this.composer.render(this.session ? undefined : this.ctx.agent(this.id), this.id);
  }

  /** Abre o painel numa conversa nova (agente ou sessão do histórico); a mesma conversa só recebe o foco. */
  private start(id: string, session: RecentSession | null, opener: HTMLElement | null): void {
    if (opener && !this.el.contains(opener)) this.opener = opener;
    if (this.id === id) {
      this.focusLog();
      return;
    }
    // Um terminal por vez: abrir outro substitui o atual (a busca e o filtro continuam valendo).
    this.disconnect();
    this.clear();
    this.id = id;
    this.session = session;
    this.last = session ? null : (this.ctx.agent(id) ?? null);
    this.loaded = false;
    this.truncated = false;
    this.follow = true;
    this.unread = 0;
    this.lastEntryAt = 0;
    if (this.el.hidden) this.movable.restore();
    this.el.hidden = false;
    this.el.classList.toggle('is-session', !!session);
    this.connect();
    this.render();
    this.focusLog();
    this.ctx.invalidate();
  }

  private renderAgentHead(): void {
    const live = this.ctx.agent(this.id!);
    if (live) this.last = live;
    const a = this.last;
    const name = a?.name ?? tr('Agente');
    setText(this.kindEl, 'terminal');
    setHidden(this.accEl, true);
    setText(this.nameEl, name);
    setTitle(this.nameEl, '');
    updateProviderTag(this.provEl, providerOf(a));
    setText(this.roleEl, a ? roleLabel(a) : '');
    setHidden(this.roleEl, !a);
    if (a) setVariant(this.roleEl, 'ui-role--', a.kind);
    const room = a ? this.ctx.store.room(a.roomId) : undefined;
    setText(this.roomEl, room ? room.name : '');
    setTitle(this.roomEl, room ? `${tr('sala {0}', [room.name])} · ${room.path}` : '');
    setHidden(this.roomEl, !room);
    this.paintBar(room?.seed);
    setAttr(this.el, 'aria-label', tr('Terminal de {0}', [name]));
    this.el.classList.toggle('is-gone', !live);
  }

  /** A barra segue a cor da sala (a mesma do cabeçalho dela na barra lateral); sessão do histórico fica na cor padrão. */
  private paintBar(seed: number | undefined): void {
    let color: string | undefined;
    try {
      if (seed !== undefined) color = roomTheme(seed).accent;
    } catch {
      // Sem tema: cor padrão.
    }
    if (color) this.barEl.style.setProperty('--room', color);
    else this.barEl.style.removeProperty('--room');
    this.barEl.classList.toggle('is-roomed', !!color);
    this.roomEl.classList.toggle('is-chip', !!color);
  }

  /** Sessão do histórico: conta, título, projeto e a data de início. */
  private renderSessionHead(s: RecentSession): void {
    const title = s.title?.trim() || tr('Sessão sem título');
    setText(this.kindEl, tr('histórico'));
    updateAccountChip(this.accEl, this.ctx.account(s.account), s.account, s.provider);
    setHidden(this.accEl, false);
    setText(this.nameEl, title);
    setTitle(this.nameEl, title);
    updateProviderTag(this.provEl, providerOf(s));
    setHidden(this.roleEl, true);
    setText(this.roomEl, `${sessionProjectName(s)} · ${formatDateTime(s.firstAt ?? s.lastAt)}`);
    setTitle(this.roomEl, s.project ?? s.projectDir);
    setHidden(this.roomEl, false);
    this.paintBar(undefined);
    setAttr(this.el, 'aria-label', tr('Terminal da sessão {0}', [title]));
    this.el.classList.remove('is-gone');
  }

  private onKey(e: KeyboardEvent): void {
    if (e.defaultPrevented) return;
    const mod = (e.ctrlKey || e.metaKey) && !e.altKey;
    const key = e.key.toLowerCase();
    // Ctrl/⌘+F com o terminal em foco busca na conversa (fora dele, continua sendo a busca do navegador).
    if (mod && !e.shiftKey && key === 'f') {
      e.preventDefault();
      e.stopPropagation();
      this.openSearch();
      return;
    }
    if (mod && key === 'g' && this.searchOpen) {
      e.preventDefault();
      this.go(e.shiftKey ? -1 : 1);
      return;
    }
    if (e.key !== 'Escape' || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    this.escape();
  }

  // ---------------------------------------------------------------- stream

  private connect(): void {
    this.disconnect();
    const id = this.id;
    if (id === null) return;
    this.conn = 'connecting';
    let es: EventSource;
    try {
      es = new EventSource(this.session ? sessionTerminalUrl(this.session.account, this.session.sessionId) : terminalUrl(id));
    } catch {
      this.conn = 'failed';
      this.renderState();
      return;
    }
    this.source = es;
    es.addEventListener('open', () => {
      if (this.source !== es) return;
      this.conn = 'open';
      this.renderState();
    });
    es.addEventListener('init', (ev) => {
      if (this.source !== es) return;
      const data = parseInit((ev as MessageEvent).data);
      if (data) this.onInit(data);
    });
    es.addEventListener('append', (ev) => {
      if (this.source !== es) return;
      const entries = parseAppend((ev as MessageEvent).data);
      if (entries.length) this.ingest(entries, false);
    });
    es.addEventListener('error', () => {
      if (this.source !== es) return;
      // Fechado = o servidor recusou (403/404/429) ou o navegador desistiu; senão, ele mesmo tenta reconectar.
      if (es.readyState === ES_CLOSED) {
        es.close();
        this.source = null;
        this.conn = 'failed';
      } else {
        this.conn = 'reconnecting';
      }
      this.renderState();
    });
    this.renderState();
  }

  private disconnect(): void {
    this.source?.close();
    this.source = null;
  }

  private onInit(data: TerminalInit): void {
    // Reconexão com o usuário lendo lá em cima: tenta manter a mesma entrada no mesmo lugar.
    const anchor = this.follow ? null : this.captureAnchor();
    this.clear();
    this.conn = 'open';
    this.loaded = true;
    this.truncated = data.truncated;
    this.earlier = data.earlier ?? 0;
    this.keep = 0;
    this.unread = 0;
    this.ingest(data.entries, true);
    // A conversa foi remontada: a busca refaz os destaques (mantendo o resultado atual, se ele ainda existir).
    if (this.folded) this.runSearch(false);
    const target = anchor ? this.rows.get(anchor.key) : undefined;
    if (anchor && target) this.scroll.scrollTop = target.offsetTop - anchor.offset;
    else {
      this.follow = true;
      this.scrollToEnd();
    }
    this.renderState();
  }

  /** Pede ao servidor as entradas anteriores às que a tela já tem e as põe no topo, sem mexer no que o usuário está lendo. */
  private async loadEarlier(): Promise<void> {
    const id = this.id;
    if (id === null || this.loadingEarlier || this.earlier <= 0) return;
    this.loadingEarlier = true;
    setText(this.earlierBtn, tr('Carregando…'));
    this.earlierBtn.disabled = true;
    const base = this.session ? sessionTerminalUrl(this.session.account, this.session.sessionId) : terminalUrl(id);
    try {
      const res = await fetch(`${base}/earlier?before=${this.earlier}`, { credentials: 'same-origin', cache: 'no-store' });
      const body = (await res.json().catch(() => ({}))) as { entries?: unknown; earlier?: unknown; error?: string };
      if (!res.ok) throw new Error(body.error ?? tr('erro {0}', [res.status]));
      if (this.id !== id) return; // abriu outra conversa enquanto esperava
      const next = typeof body.earlier === 'number' && Number.isFinite(body.earlier) && body.earlier > 0 ? body.earlier : 0;
      this.prependEntries(sanitizeEntries(body.entries));
      this.earlier = next;
      this.truncated = next > 0;
      setText(this.earlierBtn, tr('Carregar conversa anterior'));
    } catch (err) {
      setText(this.earlierBtn, tr('Não deu para carregar ({0}). Tentar de novo', [(err as Error).message]));
    } finally {
      this.loadingEarlier = false;
      this.earlierBtn.disabled = false;
      if (this.id === id) this.renderState();
    }
  }

  /** Põe entradas mais antigas no topo, mantendo na tela o que o usuário estava vendo. */
  private prependEntries(entries: readonly TerminalEntry[]): void {
    const { added, removed } = this.log.prepend(entries);
    for (const key of removed) {
      this.rows.get(key)?.remove();
      this.rows.delete(key);
    }
    const height = this.scroll.scrollHeight;
    const top = this.scroll.scrollTop;
    const now = this.ctx.now();
    const frag = document.createDocumentFragment();
    const fresh = new Map<string, HTMLElement>();
    for (const item of added) {
      const el = this.buildRow(item, now);
      el.dataset.key = item.key;
      fresh.set(item.key, el);
      frag.append(el);
    }
    // A ordem do Map é a da tela (a busca e o filtro andam por ela): as linhas novas vão na frente.
    this.rows = new Map([...fresh, ...this.rows]);
    this.list.prepend(frag);
    this.keep = Math.max(this.keep, this.log.size);
    this.follow = false;
    this.applyFilter();
    if (this.folded) this.runSearch(false);
    this.scroll.scrollTop = top + (this.scroll.scrollHeight - height);
  }

  /** Aplica um lote: cria as linhas novas num fragmento, junta resultados e descarta as linhas mais antigas. */
  private ingest(entries: readonly TerminalEntry[], initial: boolean): void {
    for (const e of entries) if (e.at > this.lastEntryAt) this.lastEntryAt = e.at;
    const batch = this.log.push(entries);
    const evicted = this.log.trim(Math.max(domLimit, this.keep));
    if (evicted.length) {
      const before = this.follow ? 0 : this.scroll.scrollHeight;
      for (const key of evicted) {
        this.rows.get(key)?.remove();
        this.rows.delete(key);
        this.tools.delete(key);
        this.hits.delete(key);
        if (this.current?.key === key) this.current = null;
      }
      // Lendo lá em cima: compensa a altura que saiu do topo para o texto não pular.
      if (!this.follow) this.scroll.scrollTop -= before - this.scroll.scrollHeight;
    }
    const touched: string[] = [];
    for (const { toolKey: key, result } of batch.attached) {
      const refs = this.tools.get(key);
      if (!refs) continue;
      attachResult(refs, result, this.copier);
      touched.push(key);
    }
    const gone = new Set(evicted);
    const now = this.ctx.now();
    const frag = document.createDocumentFragment();
    let added = 0;
    for (const item of batch.added) {
      if (gone.has(item.key)) continue;
      const el = this.buildRow(item, now);
      el.dataset.key = item.key;
      this.rows.set(item.key, el);
      frag.append(el);
      touched.push(item.key);
      added++;
    }
    this.list.append(frag);
    this.renderUndo(this.id !== null && !this.session ? (this.ctx.agent(this.id) ?? null) : null);
    this.applyFilter();
    // A busca continua valendo: destaca o que chegou (sem mudar o resultado atual).
    if (!initial && this.folded) this.refreshHits(touched);
    if (!initial) {
      if (this.follow) this.scrollToEnd();
      else this.unread += added + batch.attached.length;
      this.renderState();
    }
  }

  private buildRow(item: TerminalItem, now: number): HTMLElement {
    if (item.type === 'entry') return entryRow(item.entry, now, this.copier);
    if (item.type === 'orphan') {
      const el = row('orphan', item.result.at, now, mark(''), h('div', { class: 'ui-term__col' }, resultBlock(item.result, this.copier)));
      if (!el.title) el.title = tr('Resultado de uma ferramenta anterior');
      return el;
    }
    const refs = toolRow(item.tool, now, this.copier);
    this.tools.set(item.key, refs);
    if (item.result) attachResult(refs, item.result, this.copier);
    return refs.row;
  }

  private clear(): void {
    this.log.reset();
    this.rows.clear();
    this.tools.clear();
    this.hits.clear();
    this.current = null;
    this.currentEl = null;
    this.visibleRows = 0;
    this.list.replaceChildren();
  }

  // ---------------------------------------------------------------- copiar

  /** Botão discreto (aparece no hover ou no foco) que copia o texto de uma entrada e confirma com "Copiado". */
  private copier: Copier = (text, what) => {
    const label = tr('Copiar {0}', [what]);
    const icon = h('span', { class: 'ui-term__copy-icon', attrs: { 'aria-hidden': 'true' } });
    icon.innerHTML = ICONS.copy;
    const done = h('span', { class: 'ui-term__copy-done', text: tr('Copiado') });
    const btn = h('button', { class: 'ui-term__copy', type: 'button', title: label, attrs: { 'aria-label': label } }, icon, done);
    let timer: ReturnType<typeof setTimeout> | null = null;
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = await copyText(text);
      btn.classList.toggle('is-done', ok);
      btn.classList.toggle('is-fail', !ok);
      icon.innerHTML = ok ? ICONS.check : ICONS.copy;
      setText(done, ok ? tr('Copiado') : tr('Não foi possível copiar'));
      setTitle(btn, ok ? tr('Copiado') : tr('Não foi possível copiar'));
      this.ctx.announce(ok ? tr('Copiado.') : tr('Não foi possível copiar.'));
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        btn.classList.remove('is-done', 'is-fail');
        icon.innerHTML = ICONS.copy;
        setText(done, tr('Copiado'));
        setTitle(btn, label);
      }, COPIED_MS);
    });
    return btn;
  };

  // ---------------------------------------------------------------- filtro

  private setFilter(f: TerminalFilter): void {
    if (f === this.filter) return;
    this.filter = f;
    this.renderFilter();
    this.applyFilter();
    // O resultado atual pode ter sumido com o filtro.
    if (this.folded) {
      this.markCurrent(false);
      this.renderSearch();
    }
    if (this.follow) this.scrollToEnd();
    this.renderState();
  }

  /** Setas entre as opções do filtro (padrão de radiogroup). */
  private filterKey(e: KeyboardEvent, value: TerminalFilter): void {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    e.stopPropagation();
    const i = TERMINAL_FILTERS.findIndex(([v]) => v === value);
    const n = TERMINAL_FILTERS.length;
    const next = (i + (e.key === 'ArrowRight' ? 1 : n - 1)) % n;
    this.setFilter(TERMINAL_FILTERS[next][0]);
    this.filterBtns[next].focus();
  }

  private renderFilter(): void {
    TERMINAL_FILTERS.forEach(([value], i) => {
      const on = value === this.filter;
      setAttr(this.filterBtns[i], 'aria-checked', String(on));
      this.filterBtns[i].tabIndex = on ? 0 : -1;
    });
  }

  /** Mostra ou esconde cada linha conforme o filtro ("Só prompts" depende do que vem depois de cada resposta). */
  private applyFilter(): void {
    const finals = this.filter === 'prompts' ? finalAnswerKeys(this.log.values()) : NO_FINALS;
    let visible = 0;
    for (const item of this.log.values()) {
      const el = this.rows.get(item.key);
      if (!el) continue;
      const show = itemVisible(item, this.filter, finals);
      el.classList.toggle('is-filtered', !show);
      // Fora do "Tudo", a ferramenta com imagem ou página mostra só o resultado (sem a chamada nem a saída).
      el.classList.toggle('is-media-only', show && this.filter !== 'all' && hasMedia(item));
      if (show) visible++;
    }
    this.visibleRows = visible;
  }

  // ---------------------------------------------------------------- busca

  private toggleSearch(): void {
    if (this.searchOpen) this.closeSearch(true);
    else this.openSearch();
  }

  private openSearch(): void {
    if (this.id === null) return;
    const wasOpen = this.searchOpen;
    this.searchOpen = true;
    setHidden(this.searchBox, false);
    setAttr(this.findBtn, 'aria-expanded', 'true');
    this.findBtn.classList.add('is-on');
    this.searchInput.focus();
    this.searchInput.select();
    // Reaberta com o termo anterior: destaca de novo.
    if (!wasOpen && this.searchInput.value.trim()) this.runSearch(true);
    else this.renderSearch();
  }

  private closeSearch(focusLog: boolean): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = null;
    if (!this.searchOpen) return;
    this.searchOpen = false;
    setHidden(this.searchBox, true);
    setAttr(this.findBtn, 'aria-expanded', 'false');
    this.findBtn.classList.remove('is-on');
    this.runSearch(false);
    if (focusLog) this.focusLog();
  }

  private scheduleSearch(): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.runSearch(true), SEARCH_DEBOUNCE_MS);
  }

  /** Busca pendente (o usuário apertou Enter logo depois de digitar): roda agora. */
  private flushSearch(): void {
    if (!this.searchTimer) return;
    clearTimeout(this.searchTimer);
    this.runSearch(true);
  }

  /**
   * Refaz todos os destaques. `reset` = termo novo: o resultado atual passa a ser o primeiro a partir do que está
   * na tela; senão, mantém o atual (se ele ainda existir).
   */
  private runSearch(reset: boolean): void {
    this.searchTimer = null;
    const folded = this.searchOpen ? foldQuery(this.searchInput.value) : '';
    for (const spans of this.hits.values()) clearHits(spans);
    this.hits.clear();
    this.currentEl = null;
    const prev = this.current;
    this.current = null;
    this.folded = folded;
    if (folded) {
      for (const [key, el] of this.rows) {
        const spans = highlightHits(el, folded);
        if (spans.length) this.hits.set(key, spans);
      }
      this.current = reset ? this.firstHitInView() : prev;
      this.markCurrent(reset);
    }
    this.renderSearch();
  }

  /** Destaques de linhas novas ou alteradas (resultado que chegou), sem mexer no resultado atual. */
  private refreshHits(keys: readonly string[]): void {
    for (const key of keys) {
      const old = this.hits.get(key);
      if (old) clearHits(old);
      this.hits.delete(key);
      const el = this.rows.get(key);
      const spans = el ? highlightHits(el, this.folded) : [];
      if (spans.length) this.hits.set(key, spans);
    }
    this.markCurrent(false);
    this.renderSearch();
  }

  /** [linha, nº de destaques] das linhas visíveis, na ordem da tela. */
  private visibleCounts(): [string, number][] {
    const out: [string, number][] = [];
    for (const [key, el] of this.rows) {
      const spans = this.hits.get(key);
      if (spans && !el.classList.contains('is-filtered')) out.push([key, spans.length]);
    }
    return out;
  }

  /** O primeiro resultado visível a partir do topo da tela (ou o primeiro de todos, se não houver nenhum abaixo). */
  private firstHitInView(): SearchRef | null {
    const top = this.scroll.getBoundingClientRect().top;
    let first: SearchRef | null = null;
    for (const [key] of this.visibleCounts()) {
      first ??= { key, index: 0 };
      if (this.rows.get(key)!.getBoundingClientRect().bottom < top) continue;
      const i = this.hits.get(key)!.findIndex((s) => s.getBoundingClientRect().bottom >= top);
      if (i >= 0) return { key, index: i };
    }
    return first;
  }

  /** Próximo (1) ou anterior (-1) resultado: abre os blocos recolhidos que o escondem e rola até ele. */
  private go(dir: 1 | -1): void {
    if (!this.searchOpen) return this.openSearch();
    this.flushSearch();
    const counts = this.visibleCounts();
    const total = counts.reduce((n, [, c]) => n + c, 0);
    if (!total) return;
    this.current = refAt(counts, stepMatch(globalIndex(counts, this.current), total, dir));
    this.markCurrent(true);
    this.renderSearch(counts);
  }

  /** Marca o resultado atual (some se a linha saiu ou foi escondida pelo filtro); com `scroll`, leva até ele. */
  private markCurrent(scroll: boolean): void {
    this.currentEl?.classList.remove('is-current');
    this.currentEl = null;
    const ref = this.current;
    if (!ref) return;
    const el = this.rows.get(ref.key);
    const spans = this.hits.get(ref.key);
    if (!el || !spans?.length || el.classList.contains('is-filtered')) {
      this.current = null;
      return;
    }
    const index = Math.min(ref.index, spans.length - 1);
    const span = spans[index];
    this.current = { key: ref.key, index };
    revealWithin(span, el);
    span.classList.add('is-current');
    this.currentEl = span;
    if (scroll) this.scrollToHit(span);
  }

  private scrollToHit(span: HTMLElement): void {
    const r = span.getBoundingClientRect();
    const c = this.scroll.getBoundingClientRect();
    if (r.top < c.top + 8 || r.bottom > c.bottom - 8) this.scroll.scrollTop += r.top - c.top - (c.height - r.height) / 2;
    // Saiu do fim para ler o resultado: as mensagens novas não puxam a tela de volta.
    this.follow = this.distanceToEnd() <= STICK_PX;
    this.renderNewButton();
  }

  private renderSearch(counts = this.visibleCounts()): void {
    const total = counts.reduce((n, [, c]) => n + c, 0);
    const active = this.searchOpen && !!this.folded;
    setText(this.countEl, active ? searchCounter(globalIndex(counts, this.current), total) : '');
    setTitle(this.countEl, active ? (total ? `${total} ${total === 1 ? tr('resultado') : tr('resultados')}` : tr('Nenhum resultado')) : '');
    this.searchBox.classList.toggle('is-miss', active && total === 0);
  }

  // ---------------------------------------------------------------- rolagem

  private distanceToEnd(): number {
    const s = this.scroll;
    return s.scrollHeight - s.scrollTop - s.clientHeight;
  }

  private onScroll(): void {
    const atEnd = this.distanceToEnd() <= STICK_PX;
    if (atEnd === this.follow) return;
    this.follow = atEnd;
    if (atEnd) this.unread = 0;
    this.renderNewButton();
  }

  private scrollToEnd(): void {
    this.scroll.scrollTop = this.scroll.scrollHeight;
  }

  private jumpToEnd(): void {
    this.follow = true;
    this.unread = 0;
    this.scrollToEnd();
    this.renderNewButton();
  }

  private captureAnchor(): { key: string; offset: number } | null {
    const top = this.scroll.scrollTop;
    for (const [key, el] of this.rows) {
      if (el.classList.contains('is-filtered')) continue;
      if (el.offsetTop + el.offsetHeight > top) return { key, offset: el.offsetTop - top };
    }
    return null;
  }

  private focusLog(): void {
    this.scroll.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------- estado e rodapé

  /** "Excluir" na última mensagem do usuário: só com a sessão do terminal do Tower e o agente parado. */
  private renderUndo(live: AgentInfo | null): void {
    const ok = !!live && !this.session && ptyControllable(live) && !!ptyOfAgent(this.ctx.store, live.id) && live.status !== 'working';
    let last: Element | null = null;
    if (ok) for (const c of Array.from(this.list.children).reverse()) if (c.classList.contains('ui-term__row--user')) { last = c; break; }
    if (!last) {
      this.undoBtn?.remove();
      return;
    }
    if (!this.undoBtn) {
      const b = h('button', { class: 'ui-term__undo', type: 'button', text: tr('Excluir'), attrs: { 'data-chrome': '' } });
      b.title = tr('Apaga esta mensagem e a resposta que veio depois, como se não tivessem existido. A conversa do Claude Code volta a antes dela.');
      b.addEventListener('click', () => void this.deleteLast());
      this.undoBtn = b;
    }
    if (this.undoBtn.parentElement !== last) last.append(this.undoBtn);
  }

  private async deleteLast(): Promise<void> {
    const b = this.undoBtn;
    const agent = this.id !== null ? this.ctx.agent(this.id) : undefined;
    const pty = agent ? ptyOfAgent(this.ctx.store, agent.id) : undefined;
    const from = Number(b?.parentElement?.getAttribute('data-at'));
    if (!b || !agent || !pty || this.undoBusy || !Number.isFinite(from)) return;
    if (!(await confirmDelete())) return;
    this.undoBusy = true;
    b.disabled = true;
    try {
      for (const [keys, wait] of DELETE_LAST_STEPS) {
        await sendPtyKeys(pty.id, keys);
        if (wait) await new Promise((r) => setTimeout(r, wait));
      }
      await hideRemoved(agent.id, from);
      this.ctx.announce(tr('Mensagem apagada.'));
    } catch (err) {
      this.ctx.announce(`${tr('Não deu para apagar a mensagem')}: ${err instanceof Error ? err.message : ''}`);
    } finally {
      this.undoBusy = false;
      b.disabled = false;
    }
  }

  private renderState(): void {
    setHidden(this.reconnEl, this.conn !== 'reconnecting');
    setHidden(this.alertEl, this.conn !== 'failed');
    setText(this.alertText, this.session ? SESSION_OPEN_ERROR : OPEN_ERROR);
    setHidden(this.note, !(this.loaded && this.truncated));
    setHidden(this.earlierBtn, !(this.loaded && this.truncated && this.earlier > 0));
    const empty = this.rows.size === 0;
    const filteredOut = !empty && this.visibleRows === 0;
    setHidden(this.placeholder, !(empty || filteredOut) || this.conn === 'failed');
    if (filteredOut) setText(this.placeholder, tr('Nada para mostrar com este filtro.'));
    else if (empty) setText(this.placeholder, !this.loaded ? tr('Abrindo o terminal…') : this.session ? tr('Nenhuma mensagem nesta sessão.') : tr('Nenhuma mensagem nesta sessão ainda.'));
    this.renderNewButton();
  }

  private renderNewButton(): void {
    setHidden(this.newBtn, this.follow || this.visibleRows === 0);
    setText(this.newBtn, this.unread > 0 ? tr('↓ Novas mensagens') : tr('↓ Ir para o fim'));
  }

  private renderFooter(): void {
    if (this.id === null) return;
    const now = this.ctx.now();
    if (this.session) {
      // Sessão do histórico: horário da última atividade (o transcript pode ter crescido desde a listagem).
      const at = Math.max(this.session.lastAt, this.lastEntryAt);
      const text = sessionEndedText(at, now);
      this.stopSpinner();
      setVariant(this.status, 'is-', 'ended');
      setText(this.statusText, text);
      setTitle(this.status, `${text} (${formatDateTime(at)})`);
      setText(this.statusTime, '');
      setHidden(this.statusTime, true);
      setText(this.glyph, '■');
      return;
    }
    const agent = this.ctx.agent(this.id);
    const provider = providerOf(agent ?? this.last);
    this.frames = spinnerFrames(provider);
    const compacting = !!agent && !!this.ctx.store.snapshot?.ptys?.some((p) => p.agentId === agent.id && p.compacting && p.exitedAt === undefined);
    const f = terminalFooter(agent, this.ctx.store.snapshot?.agents ?? [], now, compacting);
    setVariant(this.status, 'is-', f.kind);
    setText(this.statusText, f.text);
    setTitle(this.status, f.text);
    let time = '';
    if (f.since !== undefined) {
      const ms = Math.max(0, now - f.since);
      if (f.kind === 'working') time = `(${formatDuration(ms)})`;
      else if (f.kind === 'shell') time = formatElapsed(ms);
      else if (f.kind === 'waiting') time = relativeTime(f.since, now);
    }
    setText(this.statusTime, time);
    setHidden(this.statusTime, !time);
    if (f.kind === 'working' && !prefersReducedMotion()) this.startSpinner();
    else {
      this.stopSpinner();
      setText(this.glyph, footerGlyph(f.kind, provider));
    }
  }

  private startSpinner(): void {
    if (this.spinTimer) return;
    setText(this.glyph, this.frames[this.spinFrame % this.frames.length]);
    this.spinTimer = setInterval(() => {
      this.spinFrame = (this.spinFrame + 1) % (this.frames.length * 8);
      setText(this.glyph, this.frames[this.spinFrame % this.frames.length]);
      // O tempo ao lado do texto anda a cada ~1 s, mesmo sem snapshot novo.
      if (this.spinFrame % 8 === 0) this.renderFooter();
    }, SPINNER_MS);
  }

  private stopSpinner(): void {
    if (this.spinTimer) clearInterval(this.spinTimer);
    this.spinTimer = null;
  }
}

function activeElement(): HTMLElement | null {
  return typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null;
}
