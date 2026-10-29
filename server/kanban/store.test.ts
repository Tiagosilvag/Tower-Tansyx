import { afterEach, describe, expect, it } from 'vitest';
import { MAX_DESCRIPTION, MAX_TITLE, type Column } from '../../shared/kanban';
import { openDb, type Db } from '../db/db';
import { UserStore } from '../users/store';
import { KanbanError, KanbanStore, type Actor } from './store';

const T0 = 1_800_000_000_000;
const abertos: Db[] = [];
afterEach(() => {
  while (abertos.length) abertos.pop()!.close();
});

const nobody: Actor = { userId: null, name: null, via: 'user' };

function montar() {
  const clock = { now: T0 };
  const db = openDb(':memory:');
  abertos.push(db);
  const users = new UserStore(db, () => clock.now);
  const tiago = users.create({ username: 'tiago', passwordHash: 'h1' });
  const ana = users.create({ username: 'ansysar', passwordHash: 'h2' });
  const store = new KanbanStore(db, () => clock.now);
  const por = (u: { id: number; username: string }, via: 'user' | 'agent' = 'user'): Actor => ({ userId: u.id, name: u.username, via });
  const geral = store.boards()[0]!;
  return { clock, db, users, store, tiago, ana, por, geral };
}

const status = (fn: () => unknown): number | undefined => {
  try {
    fn();
  } catch (err) {
    return err instanceof KanbanError ? err.status : -1;
  }
  return undefined;
};

describe('KanbanStore: quadros', () => {
  it('num banco novo só existe o Geral, e abrir de novo não duplica', () => {
    const { store, geral, db } = montar();
    expect(store.boards()).toEqual([{ id: geral.id, kind: 'general', name: 'Geral', openCount: 0 }]);
    expect(new KanbanStore(db).boards()).toHaveLength(1);
  });

  it('createBoard apara o nome; repetido em outra caixa e "Geral" são 409; vazio e 61 caracteres são 400', () => {
    const { store } = montar();
    expect(store.createBoard('  Tower Tansyx ', nobody).name).toBe('Tower Tansyx');
    expect(status(() => store.createBoard('TOWER TANSYX', nobody))).toBe(409);
    expect(status(() => store.createBoard('geral', nobody))).toBe(409);
    expect(status(() => store.createBoard('   ', nobody))).toBe(400);
    expect(status(() => store.createBoard('x'.repeat(61), nobody))).toBe(400);
  });

  it('o Geral não se renomeia nem se remove', () => {
    const { store, geral } = montar();
    expect(status(() => store.renameBoard(geral.id, 'Outro', nobody))).toBe(400);
    expect(status(() => store.deleteBoard(geral.id, true))).toBe(400);
  });

  it('projetos vêm depois do Geral, por nome; renomear respeita a unicidade', () => {
    const { store } = montar();
    const b = store.createBoard('Beta', nobody);
    store.createBoard('Alfa', nobody);
    expect(store.boards().map((x) => x.name)).toEqual(['Geral', 'Alfa', 'Beta']);
    expect(store.renameBoard(b.id, 'Gama', nobody).name).toBe('Gama');
    expect(status(() => store.renameBoard(b.id, 'alfa', nobody))).toBe(409);
  });

  it('deleteBoard de projeto com cartões pede force; com force apaga cartões e eventos; vazio apaga sem force', () => {
    const { store, db } = montar();
    const p = store.createBoard('P', nobody);
    const c = store.createCard(p.id, { title: 'a' }, nobody);
    expect(status(() => store.deleteBoard(p.id, false))).toBe(409);
    store.deleteBoard(p.id, true);
    expect(store.card(c.id)).toBeUndefined();
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM card_events')?.n).toBe(0);
    const vazio = store.createBoard('V', nobody);
    store.deleteBoard(vazio.id, false);
    expect(store.boards().map((b) => b.name)).toEqual(['Geral']);
    expect(status(() => store.deleteBoard(9999, false))).toBe(404);
  });

  it('openCount ignora a coluna feito', () => {
    const { store, geral } = montar();
    store.createCard(geral.id, { title: 'a', column: 'ideias' }, nobody);
    store.createCard(geral.id, { title: 'b', column: 'fazendo' }, nobody);
    store.createCard(geral.id, { title: 'c', column: 'feito' }, nobody);
    expect(store.boards()[0]!.openCount).toBe(2);
  });
});

describe('KanbanStore: cartões', () => {
  it('createCard põe no fim da coluna, grava o autor e um evento created com a marca', () => {
    const { store, geral, tiago, por } = montar();
    const a = store.createCard(geral.id, { title: 'A' }, por(tiago, 'agent'));
    const b = store.createCard(geral.id, { title: 'B' }, nobody);
    expect([a.column, a.position, b.position]).toEqual(['ideias', 0, 1]);
    expect(a).toMatchObject({ priority: 'media', description: '', createdBy: tiago.id, createdByName: 'tiago', createdVia: 'agent', createdAt: T0 });
    expect(store.events(a.id)).toMatchObject([{ kind: 'created', actorId: tiago.id, actorName: 'tiago', via: 'agent', detail: 'A' }]);
    expect(b).toMatchObject({ createdBy: null, createdByName: null, createdVia: 'user' });
  });

  it('createCard valida título, descrição, coluna, prioridade e responsável', () => {
    const { store, geral } = montar();
    expect(status(() => store.createCard(geral.id, { title: '  ' }, nobody))).toBe(400);
    expect(status(() => store.createCard(geral.id, { title: 'x'.repeat(MAX_TITLE + 1) }, nobody))).toBe(400);
    expect(status(() => store.createCard(geral.id, { title: 'a', description: 'x'.repeat(MAX_DESCRIPTION + 1) }, nobody))).toBe(400);
    expect(status(() => store.createCard(geral.id, { title: 'a', column: 'nada' as Column }, nobody))).toBe(400);
    expect(status(() => store.createCard(geral.id, { title: 'a', priority: 'urgente' as 'alta' }, nobody))).toBe(400);
    expect(status(() => store.createCard(geral.id, { title: 'a', assigneeId: 9999 }, nobody))).toBe(400);
    expect(status(() => store.createCard(9999, { title: 'a' }, nobody))).toBe(404);
  });

  it('updateCard grava priority "baixa→media" só quando muda de verdade', () => {
    const { store, geral, clock, tiago, por } = montar();
    const c = store.createCard(geral.id, { title: 'a', priority: 'baixa' }, nobody);
    clock.now += 1000;
    const u = store.updateCard(c.id, { priority: 'media' }, por(tiago));
    expect(u).toMatchObject({ priority: 'media', updatedAt: T0 + 1000 });
    expect(store.events(c.id)[0]).toMatchObject({ kind: 'priority', detail: 'baixa→media', actorName: 'tiago' });
    const antes = store.events(c.id).length;
    store.updateCard(c.id, { priority: 'media', title: 'a' }, por(tiago));
    expect(store.events(c.id)).toHaveLength(antes);
    expect(status(() => store.updateCard(c.id, { assigneeId: 9999 }, nobody))).toBe(400);
    expect(status(() => store.updateCard(9999, { title: 'z' }, nobody))).toBe(404);
  });

  it('updateCard troca título, descrição e responsável e grava edited e assigned', () => {
    const { store, geral, ana } = montar();
    const c = store.createCard(geral.id, { title: 'a' }, nobody);
    expect(c.assigneeName).toBeNull();
    const u = store.updateCard(c.id, { title: 'b', description: 'd', assigneeId: ana.id }, nobody);
    expect(u).toMatchObject({ title: 'b', description: 'd', assigneeId: ana.id, assigneeName: 'ansysar' });
    expect(store.events(c.id).map((e) => e.kind).sort()).toEqual(['assigned', 'created', 'edited']);
  });

  it('etiqueta de projeto: só no Geral, só para projeto, e grava tagged', () => {
    const { store, geral } = montar();
    const p = store.createBoard('P', nobody);
    const c = store.createCard(geral.id, { title: 'a' }, nobody);
    expect(store.updateCard(c.id, { projectId: p.id }, nobody).projectId).toBe(p.id);
    expect(store.events(c.id)[0]!.kind).toBe('tagged');
    expect(status(() => store.updateCard(c.id, { projectId: geral.id }, nobody))).toBe(400);
    const dentro = store.createCard(p.id, { title: 'b' }, nobody);
    expect(status(() => store.updateCard(dentro.id, { projectId: p.id }, nobody))).toBe(400);
    expect(store.updateCard(c.id, { projectId: null }, nobody).projectId).toBeNull();
  });

  it('cards() ordena por coluna e posição; a busca ignora caixa e acento e olha a descrição', () => {
    const { store, geral } = montar();
    store.createCard(geral.id, { title: 'Revisão final', column: 'fazendo' }, nobody);
    store.createCard(geral.id, { title: 'Outra', description: 'ver o CELULAR', column: 'ideias' }, nobody);
    expect(store.cards(geral.id).map((c) => c.title)).toEqual(['Outra', 'Revisão final']);
    expect(store.cards(geral.id, 'revisao').map((c) => c.title)).toEqual(['Revisão final']);
    expect(store.cards(geral.id, 'celular').map((c) => c.title)).toEqual(['Outra']);
    expect(store.cards(geral.id, '   ')).toHaveLength(2);
    expect(store.cards(9999)).toEqual([]);
  });

  it('deleteCard remove o cartão e o histórico; id inexistente é 404', () => {
    const { store, geral } = montar();
    const c = store.createCard(geral.id, { title: 'a' }, nobody);
    store.deleteCard(c.id);
    expect(store.card(c.id)).toBeUndefined();
    expect(store.events(c.id)).toEqual([]);
    expect(status(() => store.deleteCard(c.id))).toBe(404);
  });

  it('comment grava um evento comment com o texto e valida o tamanho', () => {
    const { store, geral, ana, por } = montar();
    const c = store.createCard(geral.id, { title: 'a' }, nobody);
    expect(store.comment(c.id, ' dá para usar push ', por(ana, 'agent'))).toMatchObject({ kind: 'comment', detail: 'dá para usar push', actorName: 'ansysar', via: 'agent' });
    expect(status(() => store.comment(c.id, '   ', nobody))).toBe(400);
    expect(status(() => store.comment(c.id, 'x'.repeat(2001), nobody))).toBe(400);
    expect(status(() => store.comment(9999, 'a', nobody))).toBe(404);
  });
});

describe('KanbanStore: mover', () => {
  const posicoes = (store: KanbanStore, boardId: number, column: Column) => store.cards(boardId).filter((c) => c.column === column).map((c) => [c.title, c.position]);

  it('dentro da coluna e entre colunas renumera 0..n-1 sem repetir; sem position vai para o fim', () => {
    const { store, geral } = montar();
    const [a, b, c] = ['a', 'b', 'c'].map((t) => store.createCard(geral.id, { title: t, column: 'ideias' }, nobody));
    store.moveCard(c!.id, { position: 0 }, nobody);
    expect(posicoes(store, geral.id, 'ideias')).toEqual([['c', 0], ['a', 1], ['b', 2]]);
    store.moveCard(a!.id, { column: 'fazendo' }, nobody);
    expect(posicoes(store, geral.id, 'ideias')).toEqual([['c', 0], ['b', 1]]);
    expect(posicoes(store, geral.id, 'fazendo')).toEqual([['a', 0]]);
    store.moveCard(b!.id, { column: 'fazendo', position: 0 }, nobody);
    expect(posicoes(store, geral.id, 'fazendo')).toEqual([['b', 0], ['a', 1]]);
    expect(store.events(a!.id)[0]).toMatchObject({ kind: 'moved', detail: 'ideias→fazendo' });
  });

  it('para outro quadro limpa a etiqueta, grava moved_board e renumera origem e destino', () => {
    const { store, geral } = montar();
    const p = store.createBoard('P', nobody);
    const x = store.createCard(geral.id, { title: 'x', column: 'a_fazer' }, nobody);
    const y = store.createCard(geral.id, { title: 'y', column: 'a_fazer' }, nobody);
    store.updateCard(x.id, { projectId: p.id }, nobody);
    const moved = store.moveCard(x.id, { boardId: p.id }, nobody);
    expect(moved).toMatchObject({ boardId: p.id, column: 'a_fazer', position: 0, projectId: null });
    expect(store.events(x.id)[0]).toMatchObject({ kind: 'moved_board', detail: 'Geral→P' });
    expect(store.cards(geral.id).map((c) => [c.title, c.position])).toEqual([['y', 0]]);
    expect(y.id).toBeDefined();
  });

  it('quadro de destino inexistente é 404 e deixa tudo como estava', () => {
    const { store, geral } = montar();
    store.createCard(geral.id, { title: 'a', column: 'ideias' }, nobody);
    const b = store.createCard(geral.id, { title: 'b', column: 'ideias' }, nobody);
    const antes = JSON.stringify(store.cards(geral.id));
    const eventos = store.events(b.id).length;
    expect(status(() => store.moveCard(b.id, { boardId: 9999, column: 'feito', position: 0 }, nobody))).toBe(404);
    expect(JSON.stringify(store.cards(geral.id))).toBe(antes);
    expect(store.events(b.id)).toHaveLength(eventos);
    expect(status(() => store.moveCard(b.id, { column: 'nada' as Column }, nobody))).toBe(400);
    expect(status(() => store.moveCard(9999, { column: 'feito' }, nobody))).toBe(404);
  });
});

describe('KanbanStore: usuário removido', () => {
  it('mantém cartões e histórico, com as referências nulas e os nomes gravados', () => {
    const { store, geral, users, tiago, ana, por } = montar();
    const c = store.createCard(geral.id, { title: 'a', assigneeId: tiago.id }, por(tiago, 'agent'));
    users.remove(tiago.id);
    expect(ana.id).toBeGreaterThan(0);
    expect(store.card(c.id)).toMatchObject({ title: 'a', assigneeId: null, assigneeName: null, createdBy: null, createdByName: 'tiago', createdVia: 'agent' });
    expect(store.events(c.id)[0]).toMatchObject({ kind: 'created', actorId: null, actorName: 'tiago', via: 'agent' });
  });
});
