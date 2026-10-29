import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { setUser } from './identity';
import { Presence } from './presence';
import { createPresenceRoutes } from './presence-http';
import type { User } from './store';

const servers: http.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function serve(user: User | undefined) {
  const routes = createPresenceRoutes({ presence: new Presence(), readJson: readBody });
  const server = http.createServer((req, res) => {
    if (user) setUser(req, user);
    routes(req, res);
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/presence`;
}

const ANA: User = { id: 1, username: 'ana', displayName: 'Ana', color: '#fac665', createdAt: 1 };

describe('/api/presence', () => {
  it('com login: o aviso entra e a consulta devolve quem está com o agente', async () => {
    const url = await serve(ANA);
    const post = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agents: ['a:1'], typing: 'a:1' }) });
    expect(post.status).toBe(204);
    const body = (await (await fetch(url)).json()) as { presence: Record<string, unknown[]> };
    expect(body.presence['a:1']).toEqual([{ id: 1, name: 'Ana', color: '#fac665', typing: true }]);
  });

  it('sair tira a pessoa', async () => {
    const url = await serve(ANA);
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agents: ['a:1'] }) });
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ leave: true }) });
    expect(((await (await fetch(url)).json()) as { presence: object }).presence).toEqual({});
  });

  it('sem login: o aviso não tem efeito e a lista é vazia', async () => {
    const url = await serve(undefined);
    const post = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agents: ['a:1'] }) });
    expect(post.status).toBe(204);
    expect(((await (await fetch(url)).json()) as { presence: object }).presence).toEqual({});
  });

  it('corpo que não é JSON dá 400; método diferente dá 405', async () => {
    const url = await serve(ANA);
    expect((await fetch(url, { method: 'POST', body: '{ruim' })).status).toBe(400);
    expect((await fetch(url, { method: 'DELETE' })).status).toBe(405);
  });
});
