import { describe, expect, it } from 'vitest';
import type { KanbanBoard, KanbanCard } from '../../../shared/kanban';
import { dropTarget, filterBoards, filterCards, groupByColumn, loadShelf, saveShelf, SHELF_KEY } from './kanban-model';

const card = (id: number, column: KanbanCard['column'], position: number, over: Partial<KanbanCard> = {}): KanbanCard => ({
  id, boardId: 1, column, position, title: `c${id}`, description: '', priority: 'media', assigneeId: null, projectId: null,
  createdBy: null, createdByName: null, createdVia: 'user', createdAt: 1, updatedAt: 1, ...over,
});

describe('filterCards', () => {
  const cards = [card(1, 'fazendo', 0, { title: 'Revisão final' }), card(2, 'ideias', 0, { title: 'Outra', description: 'ver o CELULAR' })];
  it('ignora caixa e acento e olha título e descrição', () => {
    expect(filterCards(cards, 'revisao').map((c) => c.id)).toEqual([1]);
    expect(filterCards(cards, 'celular').map((c) => c.id)).toEqual([2]);
    expect(filterCards(cards, 'nada')).toEqual([]);
  });
  it('busca vazia ou só espaços devolve tudo', () => {
    expect(filterCards(cards, '')).toHaveLength(2);
    expect(filterCards(cards, '   ')).toHaveLength(2);
  });
});

describe('filterBoards', () => {
  const boards: KanbanBoard[] = [
    { id: 1, kind: 'general', name: 'Geral', openCount: 0 },
    { id: 2, kind: 'project', name: 'Tower Tansyx', openCount: 3 },
    { id: 3, kind: 'project', name: 'Site da Coffetech', openCount: 1 },
  ];
  it('o Geral sempre fica; projetos filtram pelo nome sem acento nem caixa', () => {
    expect(filterBoards(boards, 'coffe').map((b) => b.id)).toEqual([1, 3]);
    expect(filterBoards(boards, 'TOWER').map((b) => b.id)).toEqual([1, 2]);
    expect(filterBoards(boards, 'zzz').map((b) => b.id)).toEqual([1]);
    expect(filterBoards(boards, '')).toHaveLength(3);
  });
});

describe('groupByColumn', () => {
  it('devolve as 4 colunas, vazias incluídas, na ordem das posições', () => {
    const g = groupByColumn([card(1, 'fazendo', 1), card(2, 'fazendo', 0), card(3, 'feito', 0)]);
    expect(Object.keys(g)).toEqual(['ideias', 'a_fazer', 'fazendo', 'feito']);
    expect(g.fazendo.map((c) => c.id)).toEqual([2, 1]);
    expect(g.ideias).toEqual([]);
    expect(g.a_fazer).toEqual([]);
  });
});

describe('dropTarget', () => {
  const cards = [card(1, 'ideias', 0), card(2, 'ideias', 1), card(3, 'ideias', 2), card(4, 'fazendo', 0), card(5, 'fazendo', 1)];
  it('outra coluna: no fim, no meio e numa coluna vazia', () => {
    expect(dropTarget(cards, 1, 'fazendo', 2)).toEqual({ column: 'fazendo', position: 2 });
    expect(dropTarget(cards, 1, 'fazendo', 1)).toEqual({ column: 'fazendo', position: 1 });
    expect(dropTarget(cards, 1, 'feito', 0)).toEqual({ column: 'feito', position: 0 });
  });
  it('mesma coluna: o índice conta o próprio cartão, então descer um cartão tira 1', () => {
    expect(dropTarget(cards, 1, 'ideias', 3)).toEqual({ column: 'ideias', position: 2 });
    expect(dropTarget(cards, 3, 'ideias', 0)).toEqual({ column: 'ideias', position: 0 });
    expect(dropTarget(cards, 2, 'ideias', 1)).toEqual({ column: 'ideias', position: 1 });
    expect(dropTarget(cards, 2, 'ideias', 2)).toEqual({ column: 'ideias', position: 1 });
  });
  it('índice fora dos limites vira o começo ou o fim', () => {
    expect(dropTarget(cards, 1, 'fazendo', 99)).toEqual({ column: 'fazendo', position: 2 });
    expect(dropTarget(cards, 1, 'fazendo', -3)).toEqual({ column: 'fazendo', position: 0 });
    expect(dropTarget(cards, 1, 'ideias', 99)).toEqual({ column: 'ideias', position: 2 });
  });
});

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
}

describe('estante lembrada', () => {
  it('guarda e lê o estado', () => {
    const st = memoryStorage();
    saveShelf({ collapsed: true, boardId: 7 }, st);
    expect(loadShelf(st)).toEqual({ collapsed: true, boardId: 7 });
  });
  it('sem armazenamento, com armazenamento que lança ou com JSON quebrado ou de formato errado, volta ao padrão', () => {
    const padrao = { collapsed: false, boardId: null };
    expect(loadShelf(null)).toEqual(padrao);
    expect(loadShelf({ getItem: () => { throw new Error('bloqueado'); } })).toEqual(padrao);
    expect(loadShelf(memoryStorage({ [SHELF_KEY]: '{oops' }))).toEqual(padrao);
    expect(loadShelf(memoryStorage({ [SHELF_KEY]: JSON.stringify({ collapsed: 'sim', boardId: 'x' }) }))).toEqual(padrao);
  });
  it('salvar não lança sem armazenamento nem com armazenamento que lança', () => {
    expect(() => saveShelf({ collapsed: true, boardId: null }, null)).not.toThrow();
    expect(() => saveShelf({ collapsed: true, boardId: null }, { setItem: () => { throw new Error('cheio'); } })).not.toThrow();
  });
});
