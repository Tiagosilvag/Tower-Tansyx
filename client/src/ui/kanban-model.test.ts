import { describe, expect, it } from 'vitest';
import type { KanbanBoard, KanbanCard } from '../../../shared/kanban';
import type { KanbanEvent } from '../../../shared/kanban';
import { applyMove, describeEvent, dropTarget, projectSuggestions, roomProjects, filterBoards, filterCards, groupByColumn, loadShelf, saveShelf, SHELF_KEY } from './kanban-model';

const card = (id: number, column: KanbanCard['column'], position: number, over: Partial<KanbanCard> = {}): KanbanCard => ({
  id, boardId: 1, column, position, title: `c${id}`, description: '', priority: 'media', assigneeId: null, assigneeName: null, projectId: null,
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

describe('applyMove', () => {
  const cards = [card(1, 'ideias', 0), card(2, 'ideias', 1), card(3, 'ideias', 2), card(4, 'fazendo', 0)];
  const view = (list: KanbanCard[]) => list.map((c) => `${c.id}:${c.column}:${c.position}`).sort();

  it('reordena dentro da coluna renumerando 0..n-1', () => {
    expect(view(applyMove(cards, 3, 'ideias', 0))).toEqual(['1:ideias:1', '2:ideias:2', '3:ideias:0', '4:fazendo:0']);
  });
  it('troca de coluna e renumera a de origem e a de destino', () => {
    expect(view(applyMove(cards, 1, 'fazendo', 0))).toEqual(['1:fazendo:0', '2:ideias:0', '3:ideias:1', '4:fazendo:1']);
    expect(view(applyMove(cards, 2, 'feito', 5))).toEqual(['1:ideias:0', '2:feito:0', '3:ideias:1', '4:fazendo:0']);
  });
  it('não muda o original e ignora id desconhecido', () => {
    applyMove(cards, 1, 'feito', 0);
    expect(cards[0]).toMatchObject({ column: 'ideias', position: 0 });
    expect(applyMove(cards, 99, 'feito', 0)).toEqual(cards);
  });
});

describe('describeEvent', () => {
  const ev = (kind: KanbanEvent['kind'], detail: string): KanbanEvent => ({ id: 1, cardId: 1, at: 1, actorId: null, actorName: null, via: 'user', kind, detail });
  it('descreve cada tipo em português, com colunas e prioridades por extenso', () => {
    expect(describeEvent(ev('created', 'Título')).text).toBe('criou o cartão');
    expect(describeEvent(ev('moved', 'ideias→a_fazer')).text).toBe('moveu de Ideias para A fazer');
    expect(describeEvent(ev('priority', 'baixa→media')).text).toBe('mudou a prioridade de baixa para média');
    expect(describeEvent(ev('edited', 'title,description')).text).toBe('editou o título e a descrição');
    expect(describeEvent(ev('edited', 'description')).text).toBe('editou a descrição');
    expect(describeEvent(ev('assigned', 'tiago')).text).toBe('passou o cartão para tiago');
    expect(describeEvent(ev('assigned', '—')).text).toBe('tirou o responsável');
    expect(describeEvent(ev('tagged', 'Tower Tansyx')).text).toBe('etiquetou com o projeto Tower Tansyx');
    expect(describeEvent(ev('tagged', '—')).text).toBe('tirou a etiqueta de projeto');
    expect(describeEvent(ev('moved_board', 'Geral→P')).text).toBe('moveu do quadro Geral para P');
  });
  it('comentário traz o texto à parte; tipo ou detalhe estranho não quebra', () => {
    expect(describeEvent(ev('comment', 'dá para usar push'))).toEqual({ text: 'comentou', quote: 'dá para usar push' });
    expect(describeEvent(ev('moved', 'lixo')).text).toBe('moveu o cartão');
    expect(describeEvent(ev('priority', 'x→y')).text).toBe('mudou a prioridade de x para y');
  });
});

describe('projectSuggestions', () => {
  const folders = [
    { name: 'Tower-Tansyx', path: '/root/projetos/Tower-Tansyx', lastAt: 300 },
    { name: 'loja-virtual', path: '/root/projetos/loja-virtual', lastAt: 500 },
    { name: 'Açaí-PDV', path: '/home/ana/acai', lastAt: 100 },
    { name: 'tower-docs', path: '/root/projetos/tower-docs', lastAt: 400 },
  ];
  const boards: KanbanBoard[] = [{ id: 1, kind: 'general', name: 'Geral', openCount: 0 }];

  it('sem texto digitado não sugere nada', () => {
    expect(projectSuggestions(folders, boards, '')).toEqual([]);
    expect(projectSuggestions(folders, boards, '   ')).toEqual([]);
  });

  it('acha pelo nome ou pelo caminho, sem diferenciar caixa nem acento, e põe o mais recente primeiro', () => {
    expect(projectSuggestions(folders, boards, 'tower').map((f) => f.name)).toEqual(['tower-docs', 'Tower-Tansyx']);
    expect(projectSuggestions(folders, boards, 'ACAI').map((f) => f.name)).toEqual(['Açaí-PDV']);
    expect(projectSuggestions(folders, boards, 'home/ana').map((f) => f.name)).toEqual(['Açaí-PDV']);
    expect(projectSuggestions(folders, boards, 'zzz')).toEqual([]);
  });

  it('não repete quem já é projeto no Kanban (mesmo nome, sem diferenciar caixa nem acento)', () => {
    const withTower: KanbanBoard[] = [...boards, { id: 2, kind: 'project', name: 'tower-tansyx', openCount: 0 }, { id: 3, kind: 'project', name: 'ACAI-pdv', openCount: 0 }];
    expect(projectSuggestions(folders, withTower, 'tower').map((f) => f.name)).toEqual(['tower-docs']);
    expect(projectSuggestions(folders, withTower, 'acai')).toEqual([]);
  });

  it('respeita o limite', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ name: `proj-${i}`, path: `/p/${i}`, lastAt: i }));
    expect(projectSuggestions(many, boards, 'proj')).toHaveLength(6);
    expect(projectSuggestions(many, boards, 'proj', 3).map((f) => f.name)).toEqual(['proj-19', 'proj-18', 'proj-17']);
  });
});

describe('roomProjects', () => {
  it('lista as salas de verdade (sem as do demo) com o horário do último evento de cada uma', () => {
    const snap = {
      rooms: [
        { id: 'r1', name: 'Tower Tansyx', path: '/root/projetos/Tower-Tansyx' },
        { id: 'r2', name: 'api-pagamentos', path: '/home/ana/api' },
        { id: 'demo:1', name: 'Demo', path: '/demo/x' },
        { id: 'r3', name: 'sem caminho', path: '' },
      ],
      agents: [
        { roomId: 'r1', lastEventAt: 100 },
        { roomId: 'r1', lastEventAt: 250 },
        { roomId: 'r2', lastEventAt: undefined },
      ],
    } as never;
    expect(roomProjects(snap)).toEqual([
      { name: 'Tower Tansyx', path: '/root/projetos/Tower-Tansyx', lastAt: 250 },
      { name: 'api-pagamentos', path: '/home/ana/api', lastAt: 0 },
    ]);
    expect(roomProjects(null)).toEqual([]);
  });
});
