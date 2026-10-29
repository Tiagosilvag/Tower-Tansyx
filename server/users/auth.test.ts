import { statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/db';
import { SESSION_MS } from '../http/remote';
import { DEFAULT_LOG_N, hashPassword, type PasswordHash } from '../remote/password';
import { tempDir } from '../test/fixtures';
import { UNKNOWN_IP, UserAuth, UserSessions, UserThrottle } from './auth';
import { UserStore } from './store';

const SECRET = Buffer.alloc(32, 9);
const T0 = 1_800_000_000_000;
// logN 10: o menor que parsePasswordHash aceita, rápido nos testes.
const HASH_A = await hashPassword('senha-certa', 10);
const HASH_B = await hashPassword('outra-senha', 10);

const abertos: Db[] = [];
afterEach(() => {
  while (abertos.length) abertos.pop()!.close();
});

function montar(verify?: (password: string, hash: PasswordHash) => Promise<boolean>) {
  const clock = { now: T0 };
  const now = () => clock.now;
  const db = openDb(':memory:');
  abertos.push(db);
  const store = new UserStore(db, now);
  const sessions = new UserSessions(SECRET, (id) => store.recordById(id), now);
  const throttle = new UserThrottle(now);
  const auth = new UserAuth(store, sessions, throttle, verify);
  return { clock, store, sessions, throttle, auth };
}

/** verify falso: acerta só 'senha-certa' e anota cada chamada. */
function verifyFalso() {
  const calls: { password: string; hash: PasswordHash }[] = [];
  const fn = async (password: string, hash: PasswordHash) => {
    calls.push({ password, hash });
    return password === 'senha-certa';
  };
  return { fn, calls };
}

describe('UserThrottle', () => {
  const IP_A = '203.0.113.9';
  const IP_B = '198.51.100.7';

  it('(a) 4 falhas liberam, a 5ª bloqueia só aquele par (usuário, IP) por 900 s; outro IP do mesmo nome não', () => {
    const clock = { now: T0 };
    const t = new UserThrottle(() => clock.now);
    for (let i = 0; i < 4; i++) t.fail('tiago', IP_A);
    expect(t.retryAfter('tiago', IP_A)).toBe(0);
    t.fail(' Tiago ', IP_A);
    expect(t.retryAfter('tiago', IP_A)).toBe(900);
    expect(t.retryAfter('TIAGO', IP_A)).toBe(900);
    // o dono do nome, de outro IP, segue entrando: o atacante tranca a si mesmo
    expect(t.retryAfter('tiago', IP_B)).toBe(0);
    // outro nome do mesmo IP só responde à retaguarda por IP (5 erros < 20)
    expect(t.retryAfter('ana', IP_A)).toBe(0);
    clock.now += 899_001;
    expect(t.retryAfter('tiago', IP_A)).toBe(1);
    clock.now += 1000;
    expect(t.retryAfter('tiago', IP_A)).toBe(0);
  });

  it('(b, contra trancar todo mundo) mais de 20 falhas em 60 s de UM IP bloqueiam só aquele IP; de outro IP a senha certa entra', async () => {
    const clock = { now: T0 };
    const now = () => clock.now;
    const db = openDb(':memory:');
    abertos.push(db);
    const store = new UserStore(db, now);
    store.create({ username: 'tiago', passwordHash: HASH_A });
    const t = new UserThrottle(now);
    const auth = new UserAuth(store, new UserSessions(SECRET, (id) => store.recordById(id), now), t, verifyFalso().fn);
    for (let i = 0; i < 20; i++) {
      t.fail(`chute${i}`, IP_A);
      clock.now += 1000;
    }
    // 20 falhas em 60 s ainda passam
    expect(t.retryAfter('qualquer', IP_A)).toBe(0);
    t.fail('chute20', IP_A); // em T0 + 20 s; a mais antiga (T0) sai da janela em T0 + 60 s
    expect(t.retryAfter('qualquer', IP_A)).toBe(40);
    expect(t.retryAfter('tiago', IP_A)).toBe(40);
    expect(await auth.login('tiago', 'senha-certa', IP_A)).toEqual({ ok: false, status: 429, retryAfter: 40 });
    // quem vem de outro IP não sente nada
    expect(t.retryAfter('tiago', IP_B)).toBe(0);
    expect((await auth.login('tiago', 'senha-certa', IP_B)).ok).toBe(true);
    clock.now = T0 + 59_500;
    expect(t.retryAfter('ana', IP_A)).toBe(1);
    clock.now = T0 + 60_000;
    expect(t.retryAfter('ana', IP_A)).toBe(0);
  });

  it('(c) teto folgado: mais de 100 falhas em 1 h para um nome, de muitos IPs, seguram só aquele nome', () => {
    const clock = { now: T0 };
    const t = new UserThrottle(() => clock.now);
    for (let i = 0; i < 100; i++) {
      t.fail('tiago', `10.0.${i}.1`);
      clock.now += 1000;
    }
    // 100 em 1 h ainda passam, de um IP novo
    expect(t.retryAfter('tiago', '192.0.2.1')).toBe(0);
    t.fail('tiago', '10.0.200.1'); // em T0 + 100 s; a mais antiga (T0) sai da janela em T0 + 1 h
    expect(t.retryAfter('tiago', '192.0.2.1')).toBe(3500);
    expect(t.retryAfter('Tiago', '10.0.3.1')).toBe(3500);
    // os outros nomes, inclusive dos mesmos IPs, seguem livres
    expect(t.retryAfter('ana', '192.0.2.1')).toBe(0);
    expect(t.retryAfter('ana', '10.0.3.1')).toBe(0);
    clock.now = T0 + 60 * 60_000;
    expect(t.retryAfter('tiago', '192.0.2.1')).toBe(0);
  });

  it('(c2) o teto por nome já estourado sobrevive a uma enchente de nomes aleatórios', () => {
    const clock = { now: T0 };
    const t = new UserThrottle(() => clock.now);
    for (let i = 0; i < 101; i++) t.fail('tiago', `10.0.${i}.1`);
    expect(t.retryAfter('tiago', '192.0.2.1')).toBeGreaterThan(0);
    // 3000 nomes novos, de IPs novos, dentro da mesma hora: o mapa por nome enche e despeja
    for (let i = 0; i < 3000; i++) {
      clock.now += 100;
      t.fail(`aleatorio${i}`, `10.${(i >> 8) + 1}.${i & 255}.1`);
    }
    expect(t['byName'].size).toBeLessThanOrEqual(1000);
    expect(t.retryAfter('tiago', '192.0.2.1')).toBeGreaterThan(0);
  });

  it('(d) sucesso zera o contador do par (usuário, IP), e só dele', () => {
    const clock = { now: T0 };
    const t = new UserThrottle(() => clock.now);
    for (let i = 0; i < 4; i++) t.fail('ana', IP_A);
    for (let i = 0; i < 4; i++) t.fail('ana', IP_B);
    t.succeed('ANA', IP_A);
    for (let i = 0; i < 4; i++) t.fail('ana', IP_A);
    expect(t.retryAfter('ana', IP_A)).toBe(0);
    // o acerto de A não zera o par de B
    t.fail('ana', IP_B);
    expect(t.retryAfter('ana', IP_B)).toBe(900);
  });

  it('(e) memória com teto nos três mapas; nenhum bloqueio cai por enchente de nomes', () => {
    const clock = { now: T0 };
    const t = new UserThrottle(() => clock.now);
    for (let i = 0; i < 5; i++) t.fail('alvo', IP_A);
    for (let i = 0; i < 3000; i++) {
      clock.now += 1;
      // nomes e IPs novos a cada erro: enche os três mapas
      t.fail(`aleatorio${i}`, `10.${i >> 8}.${i & 255}.1`);
    }
    expect(t['pairs'].size).toBeLessThanOrEqual(1000);
    expect(t['byIp'].size).toBeLessThanOrEqual(1000);
    expect(t['byName'].size).toBeLessThanOrEqual(1000);
    clock.now = T0 + 60_000 + 3000; // as janelas por IP já esvaziaram
    expect(t.retryAfter('alvo', IP_A)).toBeGreaterThan(0);
    expect(t.retryAfter('aleatorio2999', '10.11.183.1')).toBe(0);
    // vencidas saem: depois de 15 min sem falhas o mapa esvazia na próxima entrada nova
    clock.now += 16 * 60_000;
    expect(t.retryAfter('alvo', IP_A)).toBe(0);
    for (let i = 0; i < 1000; i++) t.fail(`novo${i}`, `172.16.${i >> 8}.${i & 255}`);
    expect(t['pairs'].has(`${IP_A}\nalvo`)).toBe(false);
    expect(t['pairs'].size).toBeLessThanOrEqual(1000);
    expect(t['byIp'].size).toBeLessThanOrEqual(1000);
    expect(t['byName'].size).toBeLessThanOrEqual(1000);
  });
});

describe('UserSessions', () => {
  it('(d) ida e volta devolve o id; adulterado, de outro id ou vencido ⇒ undefined', () => {
    const { clock, store, sessions } = montar();
    const tiago = store.create({ username: 'tiago', passwordHash: HASH_A });
    const ana = store.create({ username: 'ana', passwordHash: HASH_B });
    const { token, maxAgeS } = sessions.issue(tiago.id);
    expect(maxAgeS).toBe(SESSION_MS / 1000);
    expect(token).toMatch(new RegExp(`^v2\\.${tiago.id}\\.\\d+\\.[A-Za-z0-9_-]{43}$`));
    expect(sessions.verify(token)).toBe(tiago.id);
    expect(sessions.verify(token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'))).toBeUndefined();
    expect(sessions.verify(token.replace(/^v2\.\d+\./, `v2.${ana.id}.`))).toBeUndefined();
    expect(sessions.verify(token.replace(/^(v2\.\d+\.)\d+/, `$1${T0 + SESSION_MS * 2}`))).toBeUndefined();
    expect(sessions.verify(undefined)).toBeUndefined();
    expect(sessions.verify('lixo')).toBeUndefined();
    expect(sessions.verify(`v2.999.${T0 + 1000}.${'A'.repeat(43)}`)).toBeUndefined();
    clock.now += SESSION_MS + 1;
    expect(sessions.verify(token)).toBeUndefined();
  });

  it('(d, Review Focus 1) trocar a senha ou remover o usuário mata o mesmo token na hora', () => {
    const { store, sessions } = montar();
    const tiago = store.create({ username: 'tiago', passwordHash: HASH_A });
    const ana = store.create({ username: 'ana', passwordHash: HASH_B });
    const doTiago = sessions.issue(tiago.id).token;
    const daAna = sessions.issue(ana.id).token;
    store.setPasswordHash(tiago.id, HASH_B);
    expect(sessions.verify(doTiago)).toBeUndefined();
    expect(sessions.verify(daAna)).toBe(ana.id);
    const novo = sessions.issue(tiago.id).token;
    expect(sessions.verify(novo)).toBe(tiago.id);
    store.remove(ana.id);
    expect(sessions.verify(daAna)).toBeUndefined();
    expect(sessions.verify(novo)).toBe(tiago.id);
  });

  it('(d) revoke encerra só aquele token e a lista sobrevive a um novo UserSessions', () => {
    const { store } = montar();
    const tiago = store.create({ username: 'tiago', passwordHash: HASH_A });
    const tmp = tempDir();
    const file = join(tmp.dir, 'data', 'users-revoked.json');
    const lookup = (id: number) => store.recordById(id);
    const sessions = new UserSessions(SECRET, lookup, () => T0, file);
    const celular = sessions.issue(tiago.id).token;
    const notebook = new UserSessions(SECRET, lookup, () => T0 + 1).issue(tiago.id).token;
    sessions.revoke(celular);
    sessions.revoke('lixo');
    sessions.revoke(undefined);
    expect(sessions.verify(celular)).toBeUndefined();
    expect(sessions.verify(notebook)).toBe(tiago.id);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const reiniciado = new UserSessions(SECRET, lookup, () => T0, file);
    expect(reiniciado.verify(celular)).toBeUndefined();
    expect(reiniciado.verify(notebook)).toBe(tiago.id);
    tmp.cleanup();
  });
});

describe('UserAuth', () => {
  it('(c, Review Focus 2) usuário inexistente e senha errada dão o mesmo 401, e o verify roda nos dois', async () => {
    const v = verifyFalso();
    const { store, auth } = montar(v.fn);
    store.create({ username: 'tiago', passwordHash: HASH_A });
    const inexistente = await auth.login('fulano', 'senha-certa');
    const errada = await auth.login('tiago', 'senha-errada');
    expect(inexistente).toEqual({ ok: false, status: 401 });
    expect(errada).toEqual(inexistente);
    expect(v.calls).toHaveLength(2);
    // o hash de enganação é um scrypt válido, com o mesmo custo de um de verdade
    expect(v.calls[0]!.hash.hash.length).toBe(32);
    expect(v.calls[0]!.hash.logN).toBeGreaterThanOrEqual(10);
  });

  it('warm() prepara o hash de enganação sem conferir senha nem contar erro; ele tem o custo padrão', async () => {
    const v = verifyFalso();
    const { auth, throttle } = montar(v.fn);
    await expect(auth.warm()).resolves.toBeUndefined();
    expect(v.calls).toHaveLength(0);
    expect(throttle.retryAfter('fulano', UNKNOWN_IP)).toBe(0);
    expect(await auth.login('fulano', 'senha-certa')).toEqual({ ok: false, status: 401 });
    expect(v.calls[0]!.hash.logN).toBe(DEFAULT_LOG_N);
  });

  it('entradas que não são texto viram texto vazio e caem no mesmo 401, com verify', async () => {
    const v = verifyFalso();
    const { store, auth } = montar(v.fn);
    store.create({ username: 'tiago', passwordHash: HASH_A });
    expect(await auth.login(undefined, { senha: 1 })).toEqual({ ok: false, status: 401 });
    expect(await auth.login('tiago', 42)).toEqual({ ok: false, status: 401 });
    expect(v.calls.map((c) => c.password)).toEqual(['', '']);
  });

  it('5 erros bloqueiam aquele usuário com 429 sem rodar verify; o nome é normalizado no freio', async () => {
    const v = verifyFalso();
    const { clock, store, auth } = montar(v.fn);
    store.create({ username: 'tiago', passwordHash: HASH_A });
    store.create({ username: 'ana', passwordHash: HASH_B });
    for (const nome of ['tiago', ' Tiago ', 'TIAGO', 'tiago ', 'tIaGo']) {
      expect(await auth.login(nome, 'errada')).toEqual({ ok: false, status: 401 });
    }
    expect(v.calls).toHaveLength(5);
    expect(await auth.login('tiago', 'senha-certa')).toEqual({ ok: false, status: 429, retryAfter: 900 });
    expect(v.calls).toHaveLength(5);
    expect((await auth.login('ana', 'senha-certa')).ok).toBe(true);
    clock.now += 900_000;
    expect((await auth.login('Tiago', 'senha-certa')).ok).toBe(true);
  });

  it('uma conferência por vez: logins em paralelo não rodam verify ao mesmo tempo', async () => {
    let ativos = 0;
    let pico = 0;
    const verify = async (password: string) => {
      ativos++;
      pico = Math.max(pico, ativos);
      await new Promise((r) => setTimeout(r, 2));
      ativos--;
      return password === 'senha-certa';
    };
    const { store, auth } = montar(verify);
    store.create({ username: 'tiago', passwordHash: HASH_A });
    const results = await Promise.all([
      auth.login('tiago', 'x'),
      auth.login('ana', 'y'),
      auth.login('tiago', 'senha-certa'),
      auth.login('tiago', 'z'),
    ]);
    expect(pico).toBe(1);
    expect(results.map((r) => (r.ok ? 200 : r.status))).toEqual([401, 401, 200, 401]);
  });

  it('o IP do login chega ao freio: 5 erros de um IP freiam aquele IP; nome inexistente conta igual a um real', async () => {
    const v = verifyFalso();
    const { store, auth, throttle } = montar(v.fn);
    store.create({ username: 'tiago', passwordHash: HASH_A });
    for (let i = 0; i < 5; i++) {
      expect(await auth.login('tiago', 'errada', '203.0.113.9')).toEqual({ ok: false, status: 401 });
      expect(await auth.login('fulano', 'errada', '203.0.113.9')).toEqual({ ok: false, status: 401 });
    }
    expect(throttle.retryAfter('tiago', '203.0.113.9')).toBe(900);
    expect(throttle.retryAfter('fulano', '203.0.113.9')).toBe(900);
    expect(await auth.login('tiago', 'senha-certa', '203.0.113.9')).toEqual({ ok: false, status: 429, retryAfter: 900 });
    expect((await auth.login('tiago', 'senha-certa', '198.51.100.7')).ok).toBe(true);
    // sem IP: cai na chave UNKNOWN_IP, sem quebrar
    expect((await auth.login('tiago', 'senha-certa')).ok).toBe(true);
    expect(v.calls).toHaveLength(12);
  });

  it('fila com teto: o 51º login pendente recebe 429 (retryAfter 1) na hora, sem verify e sem contar erro', async () => {
    let soltar!: () => void;
    const portao = new Promise<void>((ok) => (soltar = ok));
    let chamadas = 0;
    const verify = async (password: string) => {
      chamadas++;
      await portao;
      return password === 'senha-certa';
    };
    const { store, auth, throttle } = montar(verify);
    store.create({ username: 'tiago', passwordHash: HASH_A });
    const pendentes = Array.from({ length: 50 }, (_, i) => auth.login(`nome${i}`, 'x', `10.0.0.${i}`));
    expect(await auth.login('tiago', 'senha-certa', '192.0.2.1')).toEqual({ ok: false, status: 429, retryAfter: 1 });
    expect(throttle.retryAfter('tiago', '192.0.2.1')).toBe(0);
    soltar();
    const results = await Promise.all(pendentes);
    expect(results.every((r) => !r.ok && r.status === 401)).toBe(true);
    expect(chamadas).toBe(50);
    // a fila esvaziou: entra de novo
    expect((await auth.login('tiago', 'senha-certa', '192.0.2.1')).ok).toBe(true);
  });

  it('um verify que falha conta como erro (401) e não trava a fila', async () => {
    let primeira = true;
    const verify = async (password: string) => {
      if (primeira) {
        primeira = false;
        throw new Error('scrypt quebrou');
      }
      return password === 'senha-certa';
    };
    const { store, auth } = montar(verify);
    store.create({ username: 'tiago', passwordHash: HASH_A });
    expect(await auth.login('tiago', 'senha-certa')).toEqual({ ok: false, status: 401 });
    expect((await auth.login('tiago', 'senha-certa')).ok).toBe(true);
  });

  it('issueFor emite um token novo e válido para o usuário', () => {
    const { store, sessions, auth } = montar();
    const u = store.create({ username: 'tiago', passwordHash: HASH_A });
    const { token, maxAgeS } = auth.issueFor(u.id);
    expect(maxAgeS).toBe(SESSION_MS / 1000);
    expect(sessions.verify(token)).toBe(u.id);
    expect(auth.userOf(token)?.id).toBe(u.id);
  });

  it('(e) login certo (scrypt de verdade) devolve o usuário sem hash, atualiza lastLoginAt, e logout encerra a sessão', async () => {
    const { clock, store, auth } = montar();
    const criado = store.create({ username: 'tiago', displayName: 'Tiago', passwordHash: HASH_A });
    clock.now = T0 + 5000;
    const r = await auth.login('  TIAGO ', 'senha-certa');
    if (!r.ok) throw new Error(`login falhou: ${r.status}`);
    expect(r.user).toEqual({ ...criado, lastLoginAt: T0 + 5000 });
    expect(r.user).not.toHaveProperty('passwordHash');
    expect(JSON.stringify(r)).not.toContain('scrypt');
    expect(r.maxAgeS).toBe(SESSION_MS / 1000);
    expect(store.get(criado.id)?.lastLoginAt).toBe(T0 + 5000);
    expect(auth.userOf(r.token)).toEqual(r.user);
    auth.logout(r.token);
    expect(auth.userOf(r.token)).toBeUndefined();
    expect(auth.userOf(undefined)).toBeUndefined();
  });
});
