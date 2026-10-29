import { afterEach, describe, expect, it, vi } from 'vitest';
import { kanbanApi } from './kanban';

function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('kanbanApi', () => {
  it('monta método, caminho e corpo de cada chamada', async () => {
    const calls = fakeFetch(200, { boards: [], cards: [], card: { id: 1 }, board: { id: 2 }, event: { id: 3 } });
    await kanbanApi.boards();
    await kanbanApi.cards(4, 'revisão final');
    await kanbanApi.cards(4);
    await kanbanApi.card(9);
    await kanbanApi.createBoard('P');
    await kanbanApi.renameBoard(2, 'Q');
    await kanbanApi.createCard(1, { title: 't', column: 'fazendo' });
    await kanbanApi.updateCard(9, { priority: 'alta' });
    await kanbanApi.moveCard(9, { column: 'feito', position: 0 });
    await kanbanApi.comment(9, 'oi');
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      'GET /api/kanban/boards',
      `GET /api/kanban/boards/4/cards?q=${encodeURIComponent('revisão final')}`,
      'GET /api/kanban/boards/4/cards',
      'GET /api/kanban/cards/9',
      'POST /api/kanban/boards',
      'PATCH /api/kanban/boards/2',
      'POST /api/kanban/boards/1/cards',
      'PATCH /api/kanban/cards/9',
      'POST /api/kanban/cards/9/move',
      'POST /api/kanban/cards/9/comments',
    ]);
    expect(JSON.parse(calls[6]!.init.body as string)).toEqual({ title: 't', column: 'fazendo' });
    expect(JSON.parse(calls[8]!.init.body as string)).toEqual({ column: 'feito', position: 0 });
  });

  it('remover usa DELETE, e force vira ?force=1', async () => {
    const calls = fakeFetch(204, undefined);
    await kanbanApi.deleteBoard(2);
    await kanbanApi.deleteBoard(2, true);
    await kanbanApi.deleteCard(9);
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual(['DELETE /api/kanban/boards/2', 'DELETE /api/kanban/boards/2?force=1', 'DELETE /api/kanban/cards/9']);
  });

  it('erro do servidor vira Error com a mensagem dele', async () => {
    fakeFetch(409, { error: 'já existe um projeto com esse nome' });
    await expect(kanbanApi.createBoard('P')).rejects.toThrow('já existe um projeto com esse nome');
  });
});
