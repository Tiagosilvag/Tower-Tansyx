import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/db';
import { AVATAR_COLORS, UserError, UserStore, usernameProblem } from './store';

const abertos: Db[] = [];
let relogio = 1000;

function novo(): UserStore {
  const db = openDb(':memory:');
  abertos.push(db);
  return new UserStore(db, () => relogio);
}

afterEach(() => {
  while (abertos.length) abertos.pop()!.close();
});

function status(fn: () => unknown): number | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof UserError ? err.status : -1;
  }
  return undefined;
}

describe('UserStore', () => {
  it('guarda o username em minúsculas e sem espaços', () => {
    const s = novo();
    const u = s.create({ username: ' Tiago ', passwordHash: 'x' });
    expect(u.username).toBe('tiago');
    expect(u.displayName).toBe('tiago');
    expect(u.color).toBe(AVATAR_COLORS[0]);
    expect(u.createdAt).toBe(1000);
    expect(s.count()).toBe(1);
  });

  it('rejeita username repetido sem diferenciar maiúsculas (409)', () => {
    const s = novo();
    s.create({ username: 'tiago', passwordHash: 'x' });
    expect(status(() => s.create({ username: 'TIAGO', passwordHash: 'y' }))).toBe(409);
  });

  it('rejeita usernames inválidos (400)', () => {
    const s = novo();
    for (const ruim of ['a/b', '../x', 'meu app', '', 'a'.repeat(33)]) {
      expect(status(() => s.create({ username: ruim, passwordHash: 'x' }))).toBe(400);
    }
    expect(usernameProblem('a'.repeat(32))).toBeUndefined();
    expect(usernameProblem(42)).toBeDefined();
  });

  it('record acha o registro com o hash; list e get nunca trazem o hash', () => {
    const s = novo();
    const u = s.create({ username: 'tiago', passwordHash: 'segredo' });
    expect(s.record('Tiago')?.passwordHash).toBe('segredo');
    expect(s.recordById(u.id)?.passwordHash).toBe('segredo');
    expect(s.record('outro')).toBeUndefined();
    expect(JSON.stringify(s.list())).not.toContain('segredo');
    expect(s.get(u.id)).not.toHaveProperty('passwordHash');
    expect(s.list()[0]).not.toHaveProperty('passwordHash');
  });

  it('remove: único usuário dá 409, inexistente 404, um entre dois remove', () => {
    const s = novo();
    const a = s.create({ username: 'a', passwordHash: 'x' });
    expect(status(() => s.remove(a.id))).toBe(409);
    const b = s.create({ username: 'b', passwordHash: 'x' });
    expect(b.color).toBe(AVATAR_COLORS[1]);
    expect(status(() => s.remove(999))).toBe(404);
    s.remove(a.id);
    expect(s.list().map((u) => u.username)).toEqual(['b']);
  });

  it('setPasswordHash troca o hash e dá 404 para inexistente', () => {
    const s = novo();
    const a = s.create({ username: 'a', passwordHash: 'x' });
    s.setPasswordHash(a.id, 'novo');
    expect(s.recordById(a.id)?.passwordHash).toBe('novo');
    expect(status(() => s.setPasswordHash(999, 'z'))).toBe(404);
  });

  it('touchLogin preenche lastLoginAt com o relógio injetado', () => {
    const s = novo();
    const a = s.create({ username: 'a', passwordHash: 'x' });
    expect(s.get(a.id)?.lastLoginAt).toBeUndefined();
    relogio = 5000;
    s.touchLogin(a.id);
    expect(s.get(a.id)?.lastLoginAt).toBe(5000);
  });
});
