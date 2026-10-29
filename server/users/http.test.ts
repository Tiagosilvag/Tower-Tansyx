import http, { type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../db/db';
import { readJson } from '../http/app';
import { hashPassword } from '../remote/password';
import { UserAuth, UserSessions, UserThrottle } from './auth';
import { createUsersRoutes } from './http';
import { setUser } from './identity';
import { UserStore } from './store';

const SECRET = Buffer.alloc(32, 7);
// logN 10: o menor custo que parsePasswordHash aceita (o de produção é o padrão, que seria lento aqui).
const barato = (p: string) => hashPassword(p, 10);
const SENHA_ANA = 'senha-da-ana-1';
const SENHA_BIA = 'senha-da-bia-1';
const HASH_ANA = await barato(SENHA_ANA);
const HASH_BIA = await barato(SENHA_BIA);

const limpar: Array<() => void> = [];
afterEach(() => {
  while (limpar.length) limpar.pop()!();
});

/** Servidor mínimo: o "portão" é o cookie `t=<token>`; quem o token identifica vira o usuário da requisição. */
async function montar() {
  const db = openDb(':memory:');
  const store = new UserStore(db);
  const sessions = new UserSessions(SECRET, (id) => store.recordById(id));
  const auth = new UserAuth(store, sessions, new UserThrottle());
  const ana = store.create({ username: 'ana', displayName: 'Ana', passwordHash: HASH_ANA });
  const bia = store.create({ username: 'bia', passwordHash: HASH_BIA });
  const routes = createUsersRoutes({
    store,
    auth,
    readJson: (req: IncomingMessage) => readJson(req),
    hash: barato,
    setCookie: (_req, token, maxAgeS) => `t=${token}; Max-Age=${maxAgeS}`,
  });
  const server: Server = http.createServer((req, res) => {
    const token = /(?:^|; )t=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    const user = auth.userOf(token);
    if (user) setUser(req, user);
    if (!routes(req, res, new URL(req.url ?? '/', 'http://x'))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  limpar.push(() => server.close(), () => db.close());
  const port = (server.address() as AddressInfo).port;
  const call = async (method: string, path: string, opts: { token?: string; body?: unknown } = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { ...(opts.token ? { Cookie: `t=${opts.token}` } : {}), ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await r.text();
    return { status: r.status, headers: r.headers, json: text ? JSON.parse(text) : undefined, text };
  };
  const tokenDe = (id: number) => sessions.issue(id).token;
  return { store, auth, ana, bia, call, tokenDe };
}

describe('GET /api/me', () => {
  it('sem usuário devolve 200 {user: null}; com usuário devolve o perfil sem hash', async () => {
    const { call, ana, tokenDe } = await montar();
    const anon = await call('GET', '/api/me');
    expect(anon.status).toBe(200);
    expect(anon.json).toEqual({ user: null });
    const eu = await call('GET', '/api/me', { token: tokenDe(ana.id) });
    expect(eu.json).toEqual({ user: ana });
    expect(eu.text).not.toContain('passwordHash');
    expect(eu.text).not.toContain('scrypt');
  });
});

describe('GET /api/users', () => {
  it('lista os usuários e nunca vaza o hash', async () => {
    const { call, ana, tokenDe } = await montar();
    const r = await call('GET', '/api/users', { token: tokenDe(ana.id) });
    expect(r.status).toBe(200);
    expect(r.json.users.map((u: { username: string }) => u.username)).toEqual(['ana', 'bia']);
    expect(r.text).not.toContain('passwordHash');
    expect(r.text).not.toContain('scrypt');
  });
});

describe('POST /api/users', () => {
  it('cria (201, sem hash) e o novo usuário consegue entrar', async () => {
    const { call, auth, ana, tokenDe } = await montar();
    const r = await call('POST', '/api/users', {
      token: tokenDe(ana.id),
      body: { username: 'Caio', displayName: ' Caio S. ', color: '#aabbcc', password: 'senha-do-caio-1' },
    });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ username: 'caio', displayName: 'Caio S.', color: '#aabbcc' });
    expect(r.text).not.toContain('passwordHash');
    expect((await auth.login('caio', 'senha-do-caio-1')).ok).toBe(true);
    expect((await auth.login('caio', 'outra-senha-xx')).ok).toBe(false);
  });

  it('nome repetido dá 409; senha curta, nome inválido, cor e nome de exibição inválidos dão 400', async () => {
    const { call, store, ana, tokenDe } = await montar();
    const token = tokenDe(ana.id);
    const base = { username: 'caio', password: 'senha-do-caio-1' };
    expect((await call('POST', '/api/users', { token, body: { ...base, username: 'ANA' } })).status).toBe(409);
    expect((await call('POST', '/api/users', { token, body: { ...base, password: '123456789' } })).status).toBe(400);
    expect((await call('POST', '/api/users', { token, body: { ...base, password: 12345678901 } })).status).toBe(400);
    expect((await call('POST', '/api/users', { token, body: { ...base, username: '../x' } })).status).toBe(400);
    expect((await call('POST', '/api/users', { token, body: { ...base, color: 'red' } })).status).toBe(400);
    expect((await call('POST', '/api/users', { token, body: { ...base, displayName: '   ' } })).status).toBe(400);
    expect((await call('POST', '/api/users', { token, body: { ...base, displayName: 'x'.repeat(41) } })).status).toBe(400);
    expect((await call('POST', '/api/users', { token, body: [] })).status).toBe(400);
    expect(store.count()).toBe(2);
  });
});

describe('troca de senha', () => {
  it('trocar a senha de OUTRO usuário derruba as sessões dele e mantém a de quem trocou', async () => {
    const { call, auth, ana, bia, tokenDe } = await montar();
    const tAna = tokenDe(ana.id);
    const tBia = tokenDe(bia.id);
    const r = await call('POST', `/api/users/${bia.id}/password`, { token: tAna, body: { password: 'nova-senha-da-bia' } });
    expect(r.status).toBe(204);
    expect(r.headers.get('set-cookie')).toBeNull();
    expect(auth.userOf(tBia)).toBeUndefined();
    expect(auth.userOf(tAna)?.id).toBe(ana.id);
    expect((await auth.login('bia', 'nova-senha-da-bia')).ok).toBe(true);
  });

  it('outro usuário inexistente dá 404; senha curta dá 400', async () => {
    const { call, ana, bia, tokenDe } = await montar();
    const token = tokenDe(ana.id);
    expect((await call('POST', '/api/users/999/password', { token, body: { password: 'nova-senha-longa' } })).status).toBe(404);
    expect((await call('POST', `/api/users/${bia.id}/password`, { token, body: { password: 'curta' } })).status).toBe(400);
  });

  it('a própria senha por /api/users/:id/password devolve cookie novo e a sessão continua', async () => {
    const { call, auth, ana, tokenDe } = await montar();
    const velho = tokenDe(ana.id);
    const r = await call('POST', `/api/users/${ana.id}/password`, { token: velho, body: { password: 'senha-nova-da-ana' } });
    expect(r.status).toBe(204);
    const novo = /^t=([^;]+)/.exec(r.headers.get('set-cookie') ?? '')?.[1];
    expect(novo).toBeTruthy();
    expect(auth.userOf(velho)).toBeUndefined();
    expect(auth.userOf(novo)?.id).toBe(ana.id);
  });

  it('/api/me/password exige a senha atual certa (403 senão) e devolve cookie que continua válido', async () => {
    const { call, auth, ana, tokenDe } = await montar();
    const velho = tokenDe(ana.id);
    const errada = await call('POST', '/api/me/password', { token: velho, body: { currentPassword: 'senha-errada-xx', password: 'senha-nova-da-ana' } });
    expect(errada.status).toBe(403);
    expect(errada.json.error).toEqual(expect.any(String));
    expect(auth.userOf(velho)?.id).toBe(ana.id);
    expect((await auth.login('ana', SENHA_ANA)).ok).toBe(true);

    const curta = await call('POST', '/api/me/password', { token: velho, body: { currentPassword: SENHA_ANA, password: 'curta' } });
    expect(curta.status).toBe(400);

    const certa = await call('POST', '/api/me/password', { token: velho, body: { currentPassword: SENHA_ANA, password: 'senha-nova-da-ana' } });
    expect(certa.status).toBe(204);
    const novo = /^t=([^;]+)/.exec(certa.headers.get('set-cookie') ?? '')?.[1];
    expect(auth.userOf(novo)?.id).toBe(ana.id);
    expect(auth.userOf(velho)).toBeUndefined();
    expect((await auth.login('ana', 'senha-nova-da-ana')).ok).toBe(true);
    expect((await auth.login('ana', SENHA_ANA)).ok).toBe(false);
  });

  it('senha atual errada conta no freio por usuário: depois de 5 erros, 429 com Retry-After', async () => {
    const { call, ana, tokenDe } = await montar();
    const token = tokenDe(ana.id);
    const body = { currentPassword: 'senha-errada-xx', password: 'senha-nova-da-ana' };
    for (let i = 0; i < 5; i++) expect((await call('POST', '/api/me/password', { token, body })).status).toBe(403);
    const r = await call('POST', '/api/me/password', { token, body: { ...body, currentPassword: SENHA_ANA } });
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});

describe('DELETE /api/users/:id', () => {
  it('remover a si mesmo dá 409', async () => {
    const { call, store, ana, tokenDe } = await montar();
    expect((await call('DELETE', `/api/users/${ana.id}`, { token: tokenDe(ana.id) })).status).toBe(409);
    expect(store.count()).toBe(2);
  });

  it('remover o último usuário (que é o próprio) dá 409 e a sessão continua', async () => {
    const { call, store, auth, ana, bia, tokenDe } = await montar();
    // com dois usuários, remover o outro funciona; depois só sobra o próprio e o último não sai
    expect((await call('DELETE', `/api/users/${bia.id}`, { token: tokenDe(ana.id) })).status).toBe(204);
    expect(store.count()).toBe(1);
    expect((await call('DELETE', `/api/users/${ana.id}`, { token: tokenDe(ana.id) })).status).toBe(409);
    expect(auth.userOf(tokenDe(ana.id))?.id).toBe(ana.id);
  });

  it('remover outro dá 204 e o cookie dele cai; id inexistente dá 404', async () => {
    const { call, auth, ana, bia, tokenDe } = await montar();
    const tBia = tokenDe(bia.id);
    expect((await call('DELETE', `/api/users/${bia.id}`, { token: tokenDe(ana.id) })).status).toBe(204);
    expect(auth.userOf(tBia)).toBeUndefined();
    expect((await call('DELETE', '/api/users/999', { token: tokenDe(ana.id) })).status).toBe(404);
  });
});

describe('sem usuário', () => {
  it('todas as rotas, menos GET /api/me, dão 401', async () => {
    const { call, store } = await montar();
    const casos: Array<[string, string, unknown?]> = [
      ['GET', '/api/users'],
      ['POST', '/api/users', { username: 'x', password: 'senha-longa-12' }],
      ['POST', '/api/users/1/password', { password: 'senha-longa-12' }],
      ['POST', '/api/me/password', { currentPassword: 'a', password: 'senha-longa-12' }],
      ['DELETE', '/api/users/2'],
    ];
    for (const [method, path, body] of casos) {
      const r = await call(method, path, { body });
      expect(r.status, `${method} ${path}`).toBe(401);
      expect(r.json.error).toEqual(expect.any(String));
    }
    expect(store.count()).toBe(2);
  });

  it('caminhos que não são seus ficam para o resto da API', async () => {
    const { call, ana, tokenDe } = await montar();
    expect((await call('GET', '/api/agents', { token: tokenDe(ana.id) })).status).toBe(404);
  });
});
