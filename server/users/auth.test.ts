import { statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/db';
import { SESSION_MS } from '../http/remote';
import { hashPassword, type PasswordHash } from '../remote/password';
import { tempDir } from '../test/fixtures';
import { UserAuth, UserSessions, UserThrottle } from './auth';
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
  it('(a) 4 falhas liberam, a 5ª bloqueia só aquele usuário por 900 s; sucesso zera', () => {
    const clock = { now: T0 };
    const t = new UserThrottle(() => clock.now);
    for (let i = 0; i < 4; i++) t.fail('tiago');
    expect(t.retryAfter('tiago')).toBe(0);
    t.fail(' Tiago ');
    expect(t.retryAfter('tiago')).toBe(900);
    expect(t.retryAfter('TIAGO')).toBe(900);
    expect(t.retryAfter('ana')).toBe(0);
    clock.now += 899_001;
    expect(t.retryAfter('tiago')).toBe(1);
    clock.now += 1000;
    expect(t.retryAfter('tiago')).toBe(0);

    for (let i = 0; i < 4; i++) t.fail('ana');
    t.succeed('ANA');
    for (let i = 0; i < 4; i++) t.fail('ana');
    expect(t.retryAfter('ana')).toBe(0);
  });

  it('(b) mais de 20 falhas em 60 s, de usuários variados, bloqueiam todos até a janela baixar de 20', () => {
    const clock = { now: T0 };
    const t = new UserThrottle(() => clock.now);
    for (let i = 0; i < 20; i++) {
      t.fail(`chute${i}`);
      clock.now += 1000;
    }
    // 20 falhas em 60 s ainda passam
    expect(t.retryAfter('qualquer')).toBe(0);
    t.fail('chute20'); // em T0 + 20 s; a mais antiga (T0) sai da janela em T0 + 60 s
    expect(t.retryAfter('qualquer')).toBe(40);
    expect(t.retryAfter('chute3')).toBe(40);
    clock.now = T0 + 59_500;
    expect(t.retryAfter('ana')).toBe(1);
    clock.now = T0 + 60_000;
    expect(t.retryAfter('ana')).toBe(0);
  });

  it('nomes desconhecidos contam igual, mas o mapa tem teto e nenhum bloqueio cai por enchente de nomes', () => {
    const clock = { now: T0 };
    const t = new UserThrottle(() => clock.now);
    for (let i = 0; i < 5; i++) t.fail('alvo');
    for (let i = 0; i < 3000; i++) {
      clock.now += 1;
      t.fail(`aleatorio${i}`);
    }
    expect(t['users'].size).toBeLessThanOrEqual(1000);
    clock.now = T0 + 60_000 + 3000; // a janela global já esvaziou
    expect(t.retryAfter('alvo')).toBeGreaterThan(0);
    expect(t.retryAfter('aleatorio2999')).toBe(0);
    // vencidas saem: depois de 15 min sem falhas o mapa esvazia na próxima entrada nova
    clock.now += 16 * 60_000;
    expect(t.retryAfter('alvo')).toBe(0);
    for (let i = 0; i < 1000; i++) t.fail(`novo${i}`);
    expect(t['users'].has('alvo')).toBe(false);
    expect(t['users'].has('aleatorio2999')).toBe(false);
    expect(t['users'].size).toBeLessThanOrEqual(1000);
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
