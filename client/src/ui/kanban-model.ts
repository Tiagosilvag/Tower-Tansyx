// Funções puras do Kanban da página (ui/kanban.ts): busca, agrupamento por coluna, onde cai um cartão solto e a estante
// lembrada. Testadas em kanban-model.test.ts.
import { tr } from '../../../shared/i18n';
import { isDemoId } from '../../../shared/timeline';
import type { OfficeSnapshot } from '../../../shared/types';
import { filterFolders } from './spawn';
import { COLUMNS, normalizeText, type Column, type KanbanBoard, type KanbanCard, type KanbanEvent, type Priority } from '../../../shared/kanban';

export const COLUMN_LABEL: Record<Column, string> = { ideias: tr('Ideias'), a_fazer: tr('A fazer'), fazendo: tr('Fazendo'), feito: tr('Feito') };
export const PRIORITY_LABEL: Record<Priority, string> = { alta: tr('alta'), media: tr('média'), baixa: tr('baixa') };


/** Projetos pelo nome; o Geral nunca sai da lista. Busca vazia devolve tudo. */
export function filterBoards(boards: KanbanBoard[], q: string): KanbanBoard[] {
  const needle = normalizeText(q);
  return needle ? boards.filter((b) => b.kind === 'general' || normalizeText(b.name).includes(needle)) : boards;
}

/** Cartões pelo título e pela descrição, sem diferenciar caixa nem acento. */
export function filterCards(cards: KanbanCard[], q: string): KanbanCard[] {
  const needle = normalizeText(q);
  return needle ? cards.filter((c) => normalizeText(`${c.title}\n${c.description}`).includes(needle)) : cards;
}

/** As quatro colunas (vazias também), cada uma na ordem das posições. */
export function groupByColumn(cards: KanbanCard[]): Record<Column, KanbanCard[]> {
  const out = Object.fromEntries(COLUMNS.map((c) => [c, [] as KanbanCard[]])) as Record<Column, KanbanCard[]>;
  for (const c of cards) out[c.column].push(c);
  for (const c of COLUMNS) out[c].sort((a, b) => a.position - b.position);
  return out;
}

/**
 * Onde um cartão solto cai. `index` é o espaço da coluna de destino, como aparece na tela (0 = antes do primeiro, n = depois
 * do último). O servidor tira o cartão da coluna antes de inserir, então, dentro da mesma coluna, soltar depois da posição
 * dele conta um a menos. O resultado fica sempre dentro da coluna.
 */
export function dropTarget(cards: KanbanCard[], id: number, column: Column, index: number): { column: Column; position: number } {
  const dragged = cards.find((c) => c.id === id);
  const inColumn = cards.filter((c) => c.column === column && c.id !== id).length;
  const sameColumn = dragged?.column === column;
  const shifted = sameColumn && dragged!.position < index ? index - 1 : index;
  return { column, position: Math.min(Math.max(shifted, 0), inColumn) };
}

/**
 * O resultado de mover um cartão, aplicado na cópia local (o arrasto aparece na hora, antes do servidor responder). Faz o mesmo
 * que o servidor: tira o cartão, põe na posição (cortada ao tamanho da coluna) e renumera origem e destino como 0..n-1.
 */
export function applyMove(cards: KanbanCard[], id: number, column: Column, position: number): KanbanCard[] {
  const moved = cards.find((c) => c.id === id);
  if (!moved) return cards;
  const order = (col: Column) => cards.filter((c) => c.column === col && c.id !== id).sort((a, b) => a.position - b.position);
  const dest = order(column);
  dest.splice(Math.min(Math.max(Math.trunc(position), 0), dest.length), 0, { ...moved, column });
  const renumbered = new Map<number, KanbanCard>();
  dest.forEach((c, i) => renumbered.set(c.id, { ...c, position: i }));
  if (moved.column !== column) order(moved.column).forEach((c, i) => renumbered.set(c.id, { ...c, position: i }));
  return cards.map((c) => renumbered.get(c.id) ?? c);
}

const FIELD_LABEL: Record<string, string> = { title: tr('o título'), description: tr('a descrição') };

const isColumn = (v: string | undefined): v is Column => (COLUMNS as readonly string[]).includes(v ?? '');

/** Uma linha do histórico em palavras. `quote` é o texto do comentário, mostrado à parte. */
/**
 * Print colado vem sempre como "image.png" (ou sem nome): ganha a data e a hora no nome, para os anexos não ficarem todos
 * iguais. Arquivo com nome de verdade segue como está.
 */
export function pastedFileName(name: string, type: string, now: Date): string {
  if (name && !/^image\.\w+$/i.test(name)) return name;
  const p = (n: number) => String(n).padStart(2, '0');
  const ext = type.split('/')[1]?.replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '') || 'png';
  return `print-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.${ext}`;
}

export function describeEvent(e: KanbanEvent): { text: string; quote?: string } {
  const [from, to] = e.detail.split('→');
  switch (e.kind) {
    case 'created':
      return { text: tr('criou o cartão') };
    case 'edited': {
      const fields = e.detail.split(',').map((f) => FIELD_LABEL[f]).filter((f): f is string => !!f);
      return { text: fields.length ? tr('editou {0}', [fields.join(tr(' e '))]) : tr('editou o cartão') };
    }
    case 'moved':
      return { text: isColumn(from) && isColumn(to) ? tr('moveu de {0} para {1}', [COLUMN_LABEL[from], COLUMN_LABEL[to]]) : tr('moveu o cartão') };
    case 'priority': {
      const name = (p: string | undefined) => PRIORITY_LABEL[p as Priority] ?? p ?? '';
      return { text: tr('mudou a prioridade de {0} para {1}', [name(from), name(to)]) };
    }
    case 'assigned':
      return { text: e.detail === '—' ? tr('tirou o responsável') : tr('passou o cartão para {0}', [e.detail]) };
    case 'tagged':
      return { text: e.detail === '—' ? tr('tirou a etiqueta de projeto') : tr('etiquetou com o projeto {0}', [e.detail]) };
    case 'moved_board':
      return { text: tr('moveu do quadro {0} para {1}', [from ?? '', to ?? '']) };
    case 'attached':
      return { text: tr('anexou {0}', [e.detail]) };
    case 'detached':
      return { text: tr('removeu o anexo {0}', [e.detail]) };
    case 'comment':
      return { text: tr('comentou'), quote: e.detail };
    default:
      return { text: e.kind };
  }
}

/** Um projeto que o Habblaud já conhece (uma pasta de trabalho), oferecido como nome ao criar um projeto no Kanban. */
export interface ProjectSuggestion {
  name: string;
  path: string;
  /** Último movimento (ms; 0 = desconhecido). */
  lastAt: number;
}

/**
 * Os projetos do Habblaud que batem com o que está sendo digitado (nome ou caminho, sem diferenciar caixa nem acento), os
 * mais recentes primeiro. Sem texto não sugere nada, e quem já é projeto no Kanban (mesmo nome) fica de fora: escolher esse
 * daria "já existe".
 */
export function projectSuggestions(folders: readonly ProjectSuggestion[], boards: readonly KanbanBoard[], query: string, limit = 6): ProjectSuggestion[] {
  if (!query.trim()) return [];
  const taken = new Set(boards.map((b) => normalizeText(b.name)));
  return filterFolders(folders, query)
    .filter((f) => !taken.has(normalizeText(f.name)))
    .sort((a, b) => b.lastAt - a.lastAt)
    .slice(0, limit);
}

/** As salas do escritório como projetos (reserva quando o servidor não manda a lista de pastas): só as reais, com caminho. */
export function roomProjects(snap: Pick<OfficeSnapshot, 'rooms' | 'agents'> | null | undefined): ProjectSuggestion[] {
  if (!snap) return [];
  const last = new Map<string, number>();
  for (const a of snap.agents) last.set(a.roomId, Math.max(last.get(a.roomId) ?? 0, a.lastEventAt ?? 0));
  return snap.rooms
    .filter((r) => !isDemoId(r.id) && /^(\/|[A-Za-z]:[\\/])/.test(r.path ?? ''))
    .map((r) => ({ name: r.name, path: r.path, lastAt: last.get(r.id) ?? 0 }));
}

export const SHELF_KEY = 'habblaud:kanban-shelf';

export interface ShelfState {
  collapsed: boolean;
  /** O último quadro aberto (null = ainda não escolheu: abre o Geral). */
  boardId: number | null;
}

const DEFAULT_SHELF: ShelfState = { collapsed: false, boardId: null };

/** localStorage com proteção contra navegadores que lançam ao acessá-lo (janela privada, dados bloqueados). */
function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadShelf(storage: Pick<Storage, 'getItem'> | null = safeStorage()): ShelfState {
  try {
    const raw = storage?.getItem(SHELF_KEY);
    if (!raw) return DEFAULT_SHELF;
    const v = JSON.parse(raw) as Partial<ShelfState>;
    if (typeof v.collapsed !== 'boolean' || (v.boardId !== null && !Number.isInteger(v.boardId))) return DEFAULT_SHELF;
    return { collapsed: v.collapsed, boardId: v.boardId ?? null };
  } catch {
    return DEFAULT_SHELF;
  }
}

export function saveShelf(state: ShelfState, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try {
    storage?.setItem(SHELF_KEY, JSON.stringify(state));
  } catch {
    // sem armazenamento: a estante só não lembra
  }
}
