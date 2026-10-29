import http, { type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../db/db';
import { readJson } from '../http/app';
import { setUser } from '../users/identity';
import { UserStore } from '../users/store';
import { createKanbanRoutes } from './http';
import { KanbanStore } from './store';

const limpar: Array<() => void> = [];
afterEach(() => {
  while (limpar.length) limpar.pop()!();
});

/**
 * Servidor mínimo. Cabeçalhos do teste: `x-remote: 1` finge a porta remota e `x-user: <nome>` finge o usuário da sessão
 * (o portão real anota isso na requisição; aqui o teste faz o mesmo com setUser).
 */
async function montar(opts: { writable?: (req: IncomingMessage) => boolean } = {}) {
  const db = openDb(':memory:');
  const users = new UserStore(db);
  const tiago = users.create({ username: 'tiago', passwordHash: 'h1' });
  const ana = users.create({ username: 'ansysar', passwordHash: 'h2' });
  const store = new KanbanStore(db);
  const routes = createKanbanRoutes({ store, users, readJson: (req: IncomingMessage) => readJson(req), isRemote: (req) => req.headers['x-remote'] === '1', writable: opts.writable });
  const server: Server = http.createServer((req, res) => {
    const nome = req.headers['x-user'];
    const u = typeof nome === 'string' ? users.list().find((x) => x.username === nome) : undefined;
    if (u) setUser(req, u);
    if (!routes(req, res, new URL(req.url ?? '/', 'http://x'))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  limpar.push(() => server.close(), () => db.close());
  const port = (server.address() as AddressInfo).port;
  const call = async (method: string, path: string, opts: { body?: unknown; headers?: Record<string, string> } = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...opts.headers },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await r.text();
    return { status: r.status, headers: r.headers, json: text ? JSON.parse(text) : undefined };
  };
  const geral = store.boards()[0]!.id;
  return { store, call, geral, tiago, ana };
}

const AGENTE = { 'X-Habblaud-Via': 'agent' };

describe('rotas /api/kanban', () => {
  it('a revisão sobe a cada alteração aceita (página, outro usuário, agente) e não com leitura ou erro', async () => {
    const { call, geral } = await montar();
    const rev = async () => (await call('GET', '/api/kanban/version')).json.version as number;
    const r0 = await rev();
    expect(typeof r0).toBe('number');
    await call('GET', '/api/kanban/boards');
    expect(await rev()).toBe(r0);
    const card = (await call('POST', `/api/kanban/boards/${geral}/cards`, { body: { title: 'a' } })).json.card;
    const r1 = await rev();
    expect(r1).toBeGreaterThan(r0);
    await call('POST', `/api/kanban/cards/${card.id}/move`, { body: { column: 'fazendo' }, headers: AGENTE });
    const r2 = await rev();
    expect(r2).toBeGreaterThan(r1);
    expect((await call('POST', `/api/kanban/boards/${geral}/cards`, { body: {} })).status).toBe(400);
    expect(await rev()).toBe(r2);
    expect((await call('POST', '/api/kanban/version', { body: {} })).status).toBe(405);
  });

  it('o cartão novo fica com quem o pediu como responsável; null explícito deixa sem, e o cartão traz nome e cor', async () => {
    const { call, geral, ana } = await montar();
    const remoto = { 'x-remote': '1', 'x-user': 'ansysar' };
    const meu = (await call('POST', `/api/kanban/boards/${geral}/cards`, { body: { title: 'meu' }, headers: remoto })).json.card;
    expect(meu).toMatchObject({ assigneeId: ana.id, assigneeName: 'ansysar', assigneeDisplayName: 'ansysar', assigneeColor: ana.color });
    const sem = (await call('POST', `/api/kanban/boards/${geral}/cards`, { body: { title: 'sem', assigneeId: null }, headers: remoto })).json.card;
    expect(sem.assigneeId).toBeNull();
    const agente = (await call('POST', `/api/kanban/boards/${geral}/cards`, { body: { title: 'ag', as: 'ansysar' }, headers: AGENTE })).json.card;
    expect(agente.assigneeId).toBe(ana.id);
    const anonimo = (await call('POST', `/api/kanban/boards/${geral}/cards`, { body: { title: 'anon' } })).json.card;
    expect(anonimo.assigneeId).toBeNull();
  });

  it('quadros: lista, cria, renomeia e remove (com force)', async () => {
    const { call, geral } = await montar();
    expect((await call('GET', '/api/kanban/boards')).json.boards).toEqual([{ id: geral, kind: 'general', name: 'Geral', openCount: 0 }]);
    const made = await call('POST', '/api/kanban/boards', { body: { name: 'Projeto X' } });
    expect(made.status).toBe(201);
    const id = made.json.board.id as number;
    expect((await call('PATCH', `/api/kanban/boards/${id}`, { body: { name: 'Projeto Y' } })).json.board.name).toBe('Projeto Y');
    expect((await call('POST', '/api/kanban/boards', { body: { name: 'projeto y' } })).status).toBe(409);
    await call('POST', `/api/kanban/boards/${id}/cards`, { body: { title: 'a' } });
    expect((await call('DELETE', `/api/kanban/boards/${id}`)).status).toBe(409);
    expect((await call('DELETE', `/api/kanban/boards/${id}?force=1`)).status).toBe(204);
    expect((await call('DELETE', `/api/kanban/boards/${geral}?force=1`)).status).toBe(400);
  });

  it('cartões: cria, lista com busca, mostra com histórico, edita, move, comenta e remove', async () => {
    const { call, geral } = await montar();
    const made = await call('POST', `/api/kanban/boards/${geral}/cards`, { body: { title: 'Revisão final', priority: 'alta', column: 'a_fazer' } });
    expect(made.status).toBe(201);
    const id = made.json.card.id as number;
    expect((await call('GET', `/api/kanban/boards/${geral}/cards?q=revisao`)).json.cards).toHaveLength(1);
    expect((await call('GET', `/api/kanban/boards/${geral}/cards?q=nada`)).json.cards).toHaveLength(0);
    const shown = await call('GET', `/api/kanban/cards/${id}`);
    expect(shown.json.card.title).toBe('Revisão final');
    expect(shown.json.events[0].kind).toBe('created');
    expect((await call('PATCH', `/api/kanban/cards/${id}`, { body: { priority: 'baixa' } })).json.card.priority).toBe('baixa');
    expect((await call('POST', `/api/kanban/cards/${id}/move`, { body: { column: 'fazendo', position: 0 } })).json.card.column).toBe('fazendo');
    const c = await call('POST', `/api/kanban/cards/${id}/comments`, { body: { text: 'oi' } });
    expect(c.status).toBe(201);
    expect(c.json.event.detail).toBe('oi');
    expect((await call('DELETE', `/api/kanban/cards/${id}`)).status).toBe(204);
    expect((await call('GET', `/api/kanban/cards/${id}`)).status).toBe(404);
  });

  it('método errado é 405 com Allow; id e rota desconhecidos são 404; corpo inválido é 400', async () => {
    const { call, geral } = await montar();
    const r = await call('PUT', '/api/kanban/boards');
    expect(r.status).toBe(405);
    expect(r.headers.get('allow')).toBe('GET, POST');
    expect((await call('GET', '/api/kanban/cards/9999')).status).toBe(404);
    expect((await call('GET', '/api/kanban/nada')).status).toBe(404);
    expect((await call('POST', `/api/kanban/boards/${geral}/cards`, { body: { title: 42 } })).status).toBe(400);
    expect((await call('POST', `/api/kanban/boards/${geral}/cards`, { body: {} })).status).toBe(400);
    expect((await call('POST', `/api/kanban/boards/${geral}/cards`, { body: { title: 'x'.repeat(201) } })).status).toBe(400);
    expect((await call('POST', `/api/kanban/boards/${geral}/cards`, { body: { title: 'a', column: 'nada' } })).status).toBe(400);
    expect((await call('POST', `/api/kanban/boards/${geral}/cards`, { body: { title: 'a', assigneeId: 'x' } })).status).toBe(400);
  });

  it('toda resposta vem com Cache-Control: no-store', async () => {
    const { call } = await montar();
    expect((await call('GET', '/api/kanban/boards')).headers.get('cache-control')).toBe('no-store');
    expect((await call('GET', '/api/kanban/cards/9999')).headers.get('cache-control')).toBe('no-store');
  });
});

describe('autoria', () => {
  const criar = (call: Awaited<ReturnType<typeof montar>>['call'], geral: number, body: object, headers: Record<string, string> = {}) =>
    call('POST', `/api/kanban/boards/${geral}/cards`, { body: { title: 'a', ...body }, headers });

  it('(1) remota: o usuário da sessão manda, e "as" com o cabeçalho de agente é ignorado', async () => {
    const { call, geral, ana } = await montar();
    const r = await criar(call, geral, { as: 'tiago' }, { ...AGENTE, 'x-remote': '1', 'x-user': 'ansysar' });
    expect(r.status).toBe(201);
    expect(r.json.card).toMatchObject({ createdBy: ana.id, createdByName: 'ansysar', createdVia: 'user' });
  });

  it('(2) local com agente: "as" vale; desconhecido ou ausente grava autor vazio e via agent, sem erro', async () => {
    const { call, geral, tiago } = await montar();
    expect((await criar(call, geral, { as: 'tiago' }, AGENTE)).json.card).toMatchObject({ createdBy: tiago.id, createdByName: 'tiago', createdVia: 'agent' });
    expect((await criar(call, geral, { as: '  TIAGO ' }, AGENTE)).json.card).toMatchObject({ createdBy: tiago.id, createdVia: 'agent' });
    const fantasma = await criar(call, geral, { as: 'fantasma' }, AGENTE);
    expect(fantasma.status).toBe(201);
    expect(fantasma.json.card).toMatchObject({ createdBy: null, createdByName: null, createdVia: 'agent' });
    expect((await criar(call, geral, {}, AGENTE)).json.card).toMatchObject({ createdBy: null, createdVia: 'agent' });
  });

  it('local sem o cabeçalho (a página): sem usuário e via user, mesmo com "as"', async () => {
    const { call, geral } = await montar();
    expect((await criar(call, geral, { as: 'tiago' })).json.card).toMatchObject({ createdBy: null, createdVia: 'user' });
  });

  it('remota sem usuário na sessão (usuário único): autor vazio e via user', async () => {
    const { call, geral } = await montar();
    expect((await criar(call, geral, {}, { 'x-remote': '1' })).json.card).toMatchObject({ createdBy: null, createdVia: 'user' });
  });

  it('o histórico de edição, movimento e comentário leva o autor e a marca', async () => {
    const { call, geral } = await montar();
    const id = (await criar(call, geral, {})).json.card.id as number;
    await call('PATCH', `/api/kanban/cards/${id}`, { body: { priority: 'alta', as: 'tiago' }, headers: AGENTE });
    await call('POST', `/api/kanban/cards/${id}/comments`, { body: { text: 'ok', as: 'ansysar' }, headers: AGENTE });
    const events = (await call('GET', `/api/kanban/cards/${id}`)).json.events as Array<{ kind: string; actorName: string | null; via: string }>;
    expect(events.map((e) => [e.kind, e.actorName, e.via])).toEqual([['comment', 'ansysar', 'agent'], ['priority', 'tiago', 'agent'], ['created', null, 'user']]);
  });
});

describe('porta local exposta na rede', () => {
  const exposta = () => montar({ writable: () => false });

  it('só leitura: qualquer escrita local é 403, mesmo com o cabeçalho de agente e "as" de um usuário real', async () => {
    const { call, geral } = await exposta();
    expect((await call('GET', '/api/kanban/boards')).status).toBe(200);
    const post = await call('POST', `/api/kanban/boards/${geral}/cards`, { body: { title: 'x', as: 'tiago' }, headers: AGENTE });
    expect(post.status).toBe(403);
    expect((await call('POST', '/api/kanban/boards', { body: { name: 'P' } })).status).toBe(403);
    expect((await call('PATCH', '/api/kanban/cards/1', { body: { title: 'y' } })).status).toBe(403);
    expect((await call('DELETE', '/api/kanban/cards/1', { body: {} })).status).toBe(403);
    expect((await call('GET', `/api/kanban/boards/${geral}/cards`)).json.cards).toEqual([]);
  });

  it('a sessão remota logada segue escrevendo (quem a trava é o portão, não esta regra)', async () => {
    const { call, geral, ana } = await exposta();
    const r = await call('POST', `/api/kanban/boards/${geral}/cards`, { body: { title: 'x' }, headers: { 'x-remote': '1', 'x-user': 'ansysar' } });
    expect(r.status).toBe(201);
    expect(r.json.card.createdBy).toBe(ana.id);
  });
});
