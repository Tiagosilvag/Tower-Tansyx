import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../db/db';
import { COOKIE, createRemoteGate, loginPage, RemoteSessions, type RemoteGateDeps } from '../http/remote';
import { hashPassword, parsePasswordHash } from '../remote/password';
import { tempDir } from '../test/fixtures';
import { UserAuth, UserSessions, UserThrottle } from './auth';
import { setUser, userOf } from './identity';
import { UserStore } from './store';

const SECRET = Buffer.alloc(32, 7);
const T0 = 1_800_000_000_000;
// logN 10: o menor que parsePasswordHash aceita, rápido nos testes.
const HASH_ANA = await hashPassword('senha-da-ana', 10);
const HASH_BIA = await hashPassword('senha-da-bia', 10);

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function start(opts: { secure?: RemoteGateDeps['secure']; auth?: (a: UserAuth) => UserAuth } = {}) {
  const tmp = tempDir('habblaud-gate-');
  const clock = { now: T0 };
  const now = () => clock.now;
  const db = openDb(':memory:');
  const store = new UserStore(db, now);
  const ana = store.create({ username: 'ana', displayName: 'Ana', passwordHash: HASH_ANA });
  const bia = store.create({ username: 'bia', passwordHash: HASH_BIA });
  // arquivo próprio da lista de encerrados: duas instâncias no mesmo arquivo apagariam as entradas uma da outra
  const sessions = new UserSessions(SECRET, (id) => store.recordById(id), now, join(tmp.dir, 'remote-users-revoked.json'));
  const real = new UserAuth(store, sessions, new UserThrottle(now));
  const users = opts.auth ? opts.auth(real) : real;
  const gate = createRemoteGate({ users, secure: opts.secure ?? false });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (gate(req, res, url)) return;
    req.resume();
    const user = userOf(req);
    const body = JSON.stringify({ path: url.pathname, user: user?.username ?? null });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const close = async () => {
    await new Promise<void>((ok) => server.close(() => ok()));
    db.close();
    tmp.cleanup();
  };
  closers.push(close);
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, store, clock, ana, bia };
}

function request(
  base: string,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const url = new URL(path, base);
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  return new Promise((ok, fail) => {
    const req = http.request(
      url,
      { method: opts.method ?? 'GET', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...opts.headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => ok({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', fail);
    req.end(body);
  });
}

const tryLogin = (base: string, user: string, password: string, headers: Record<string, string> = {}) =>
  request(base, '/api/remote/login', { method: 'POST', body: { user, password }, headers });

async function login(base: string, user: string, password: string): Promise<string> {
  const r = await tryLogin(base, user, password);
  expect(r.status).toBe(200);
  return r.headers['set-cookie']![0]!.split(';')[0]!;
}

describe('portão com usuários', () => {
  it('login certo: 200, cookie HttpOnly/SameSite=Strict, e a rota atrás do portão enxerga o usuário', async () => {
    const s = await start();
    const r = await tryLogin(s.base, ' Ana ', 'senha-da-ana');
    expect(r.status).toBe(200);
    const setCookie = r.headers['set-cookie']?.[0] ?? '';
    expect(setCookie.startsWith(`${COOKIE}=v2.`)).toBe(true);
    expect(setCookie).toMatch(/; HttpOnly/);
    expect(setCookie).toMatch(/; SameSite=Strict/);
    expect(setCookie).toMatch(/; Path=\//);
    expect(setCookie).toMatch(/; Max-Age=\d+/);
    expect(setCookie).not.toMatch(/Secure/);
    // nada do hash sai na resposta
    expect(r.body).not.toMatch(/scrypt|passwordHash|\$/);
    const cookie = setCookie.split(';')[0]!;
    const me = await request(s.base, '/api/quem', { headers: { Cookie: cookie } });
    expect(me.status).toBe(200);
    expect(JSON.parse(me.body)).toEqual({ path: '/api/quem', user: 'ana' });
    // já logado, /login volta para o escritório
    const page = await request(s.base, '/login', { headers: { Cookie: cookie } });
    expect(page.status).toBe(302);
    expect(page.headers.location).toBe('/');
  });

  it('senha errada e usuário inexistente: 401 com o mesmo corpo e sem cookie', async () => {
    const s = await start();
    const wrong = await tryLogin(s.base, 'ana', 'chute');
    const ghost = await tryLogin(s.base, 'fantasma', 'senha-da-ana');
    const garbage = await request(s.base, '/api/remote/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x' });
    for (const r of [wrong, ghost, garbage]) {
      expect(r.status).toBe(401);
      expect(JSON.parse(r.body)).toEqual({ error: 'Usuário ou senha incorretos.' });
      expect(r.headers['set-cookie']).toBeUndefined();
    }
    expect(wrong.body).toBe(ghost.body);
  });

  it('6ª tentativa do mesmo usuário: 429 com Retry-After; o outro usuário segue entrando', async () => {
    const s = await start();
    for (let i = 0; i < 5; i++) expect((await tryLogin(s.base, 'ana', `chute${i}`)).status).toBe(401);
    // nem a senha certa passa enquanto o nome está bloqueado
    const r = await tryLogin(s.base, 'ana', 'senha-da-ana');
    expect(r.status).toBe(429);
    expect(r.headers['retry-after']).toBe('900');
    expect(JSON.parse(r.body)).toEqual({ error: 'Muitas tentativas. Tente de novo em 900 s.' });
    expect(r.headers['set-cookie']).toBeUndefined();
    expect((await tryLogin(s.base, 'bia', 'senha-da-bia')).status).toBe(200);
  });

  it('sem login: a API é 401 e a página vira /login (tela do Tower Tansyx)', async () => {
    const s = await start();
    const api = await request(s.base, '/api/state');
    expect(api.status).toBe(401);
    const page = await request(s.base, '/');
    expect(page.status).toBe(302);
    expect(page.headers.location).toBe('/login');
    const loginHtml = await request(s.base, '/login');
    expect(loginHtml.status).toBe(200);
    expect(loginHtml.headers['x-frame-options']).toBe('DENY');
    expect(loginHtml.body).toContain('<title>Tower Tansyx · entrar</title>');
    expect(loginHtml.body).toContain('/api/remote/login');
    // cookie qualquer (ou do modo antigo) não entra
    const bogus = await request(s.base, '/api/state', { headers: { Cookie: `${COOKIE}=v2.1.1900000000000.${'A'.repeat(43)}` } });
    expect(bogus.status).toBe(401);
  });

  it('usuário removido: o cookie antigo dá 401 na hora', async () => {
    const s = await start();
    const cookie = await login(s.base, 'ana', 'senha-da-ana');
    expect((await request(s.base, '/api/quem', { headers: { Cookie: cookie } })).status).toBe(200);
    s.store.remove(s.ana.id);
    expect((await request(s.base, '/api/quem', { headers: { Cookie: cookie } })).status).toBe(401);
    const page = await request(s.base, '/', { headers: { Cookie: cookie } });
    expect(page.status).toBe(302);
    expect(page.headers.location).toBe('/login');
  });

  it('senha trocada (setPasswordHash): o cookie antigo dá 401; a senha nova entra', async () => {
    const s = await start();
    const cookie = await login(s.base, 'ana', 'senha-da-ana');
    const novo = await hashPassword('senha-nova', 10);
    expect(parsePasswordHash(novo)).toBeDefined();
    s.store.setPasswordHash(s.ana.id, novo);
    expect((await request(s.base, '/api/quem', { headers: { Cookie: cookie } })).status).toBe(401);
    expect((await tryLogin(s.base, 'ana', 'senha-da-ana')).status).toBe(401);
    const fresh = await login(s.base, 'ana', 'senha-nova');
    expect(JSON.parse((await request(s.base, '/api/quem', { headers: { Cookie: fresh } })).body).user).toBe('ana');
  });

  it('"Sair": o mesmo token deixa de valer e o cookie é apagado', async () => {
    const s = await start();
    const cookie = await login(s.base, 'ana', 'senha-da-ana');
    const other = await login(s.base, 'bia', 'senha-da-bia');
    const out = await request(s.base, '/api/remote/logout', { method: 'POST', headers: { Cookie: cookie } });
    expect(out.status).toBe(200);
    expect(out.headers['set-cookie']?.[0]).toMatch(new RegExp(`^${COOKIE}=; .*Max-Age=0`));
    expect((await request(s.base, '/api/quem', { headers: { Cookie: cookie } })).status).toBe(401);
    // a sessão de outra pessoa não cai junto
    expect((await request(s.base, '/api/quem', { headers: { Cookie: other } })).status).toBe(200);
    expect((await request(s.base, '/api/remote/logout', { headers: { Cookie: other } })).status).toBe(405);
  });

  it('Secure por pedido: com X-Forwarded-Proto: https e confiança no proxy; não sem isso', async () => {
    const secureFor = (trust: boolean) => (req: http.IncomingMessage) => trust && req.headers['x-forwarded-proto'] === 'https';
    const trusted = await start({ secure: secureFor(true) });
    const https = { 'X-Forwarded-Proto': 'https' };
    const a = await tryLogin(trusted.base, 'ana', 'senha-da-ana', https);
    expect(a.headers['set-cookie']?.[0]).toMatch(/; Secure$/);
    const b = await tryLogin(trusted.base, 'ana', 'senha-da-ana');
    expect(b.headers['set-cookie']?.[0]).not.toMatch(/Secure/);
    const outSecure = await request(trusted.base, '/api/remote/logout', { method: 'POST', headers: https });
    expect(outSecure.headers['set-cookie']?.[0]).toMatch(/; Secure$/);
    const outPlain = await request(trusted.base, '/api/remote/logout', { method: 'POST' });
    expect(outPlain.headers['set-cookie']?.[0]).not.toMatch(/Secure/);

    const untrusted = await start({ secure: secureFor(false) });
    const c = await tryLogin(untrusted.base, 'ana', 'senha-da-ana', https);
    expect(c.status).toBe(200);
    expect(c.headers['set-cookie']?.[0]).not.toMatch(/Secure/);

    const fixed = await start({ secure: true });
    expect((await tryLogin(fixed.base, 'ana', 'senha-da-ana')).headers['set-cookie']?.[0]).toMatch(/; Secure$/);
  });

  it('falha interna depois da senha certa: 500 genérico, sem cookie e sem vazar a mensagem', async () => {
    const s = await start({
      auth: (a) => {
        a.login = () => Promise.reject(new Error('SQLITE_BUSY: segredo interno'));
        return a;
      },
    });
    const r = await tryLogin(s.base, 'ana', 'senha-da-ana');
    expect(r.status).toBe(500);
    expect(JSON.parse(r.body)).toEqual({ error: 'erro interno' });
    expect(r.body).not.toContain('SQLITE');
    expect(r.headers['set-cookie']).toBeUndefined();
  });

  it('setUser/userOf: só a requisição marcada tem usuário', () => {
    const req = new http.IncomingMessage(null as never);
    const other = new http.IncomingMessage(null as never);
    setUser(req, { id: 1, username: 'ana', displayName: 'Ana', color: '#fac665', createdAt: T0 });
    expect(userOf(req)?.username).toBe('ana');
    expect(userOf(other)).toBeUndefined();
  });

  it('createRemoteGate exige users, ou config e sessions (um só dos dois)', () => {
    const db = openDb(':memory:');
    const store = new UserStore(db);
    const users = new UserAuth(store, new UserSessions(SECRET, (id) => store.recordById(id)), new UserThrottle());
    const cfg = { user: 'tiago', passwordHash: parsePasswordHash(HASH_ANA)!, passwordHashText: HASH_ANA };
    const sessions = new RemoteSessions(SECRET, cfg);
    expect(() => createRemoteGate({ secure: false })).toThrow();
    expect(() => createRemoteGate({ users, config: cfg, sessions, secure: false })).toThrow();
    expect(() => createRemoteGate({ config: cfg, secure: false })).toThrow();
    expect(() => createRemoteGate({ users, sessions, secure: false })).toThrow();
    expect(() => createRemoteGate({ users, secure: false })).not.toThrow();
    expect(() => createRemoteGate({ config: cfg, sessions, secure: false })).not.toThrow();
    db.close();
  });
});

describe('loginPage', () => {
  it('modo de usuários: marca do Tower Tansyx, sem nada de outro host', () => {
    const html = loginPage({ caDownload: false, users: true });
    expect(html).toContain('<title>Tower Tansyx · entrar</title>');
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="Tower Tansyx">');
    expect(html).toMatch(/<span class="tower">Tower<\/span>\s*<span class="tansyx">Tansyx<\/span>/);
    expect(html).toContain('#f4f1ea');
    expect(html).toContain('#fac665');
    expect(html).toContain('"Pixelify Sans", ui-monospace, monospace');
    expect(html).toContain('Entre para ver o escritório');
    expect(html).toContain('>Usuário</label>');
    expect(html).toContain('>Senha</label>');
    expect(html).toContain('>Entrar</button>');
    expect(html).toContain('/api/remote/login');
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/@import|<link[^>]+stylesheet/);
    expect(html).not.toContain('npm run remote:setup');
    expect(loginPage({ caDownload: true, users: true })).toContain('/remote/ca.crt');
  });

  it('modo de usuário único: a página de antes', () => {
    const html = loginPage({ caDownload: false, users: false });
    expect(html).toContain('<title>Habblaud · entrar</title>');
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="Habblaud">');
    expect(html).toContain('<h1>Habblaud</h1>');
    expect(html).toContain('npm run remote:setup');
    expect(html).not.toContain('Tower Tansyx');
  });
});
