// Funções puras do Kanban da página (ui/kanban.ts): busca, agrupamento por coluna, onde cai um cartão solto e a estante
// lembrada. Testadas em kanban-model.test.ts.
import { COLUMNS, normalizeText, type Column, type KanbanBoard, type KanbanCard } from '../../../shared/kanban';

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
