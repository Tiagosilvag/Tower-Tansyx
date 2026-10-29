import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, openDb, type Db } from './db';

const abertos: Db[] = [];
const pastas: string[] = [];

function abrir(file: string): Db {
  const db = openDb(file);
  abertos.push(db);
  return db;
}

afterEach(() => {
  for (const db of abertos.splice(0)) {
    try {
      db.close();
    } catch {
      // já fechado pelo teste
    }
  }
  for (const p of pastas.splice(0)) rmSync(p, { recursive: true, force: true });
});

describe('openDb', () => {
  it('aplica as migrações e cria a tabela users', () => {
    const db = abrir(':memory:');
    expect(db.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(MIGRATIONS.length);
    expect(db.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")?.name).toBe(
      'users',
    );
  });

  it('reabrir o arquivo não repete a migração e mantém os dados', () => {
    const pasta = mkdtempSync(join(tmpdir(), 'tower-db-'));
    pastas.push(pasta);
    const file = join(pasta, 'sub', 'tower.db');
    const a = abrir(file);
    a.run('INSERT INTO users (username, display_name, color, password_hash, created_at) VALUES (?, ?, ?, ?, ?)', 'ana', 'Ana', '#fff', 'h', 1);
    a.close();
    const b = abrir(file);
    expect(b.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(MIGRATIONS.length);
    expect(b.all<{ username: string }>('SELECT username FROM users')).toEqual([{ username: 'ana' }]);
  });

  it('transaction que lança desfaz o INSERT', () => {
    const db = abrir(':memory:');
    expect(() =>
      db.transaction(() => {
        db.run('INSERT INTO users (username, display_name, color, password_hash, created_at) VALUES (?, ?, ?, ?, ?)', 'bia', 'Bia', '#000', 'h', 1);
        throw new Error('falhou');
      }),
    ).toThrow('falhou');
    expect(db.get('SELECT id FROM users')).toBeUndefined();
  });

  it('banco em arquivo (com -wal e -shm) fica 0600 mesmo com umask 022; pasta nova nasce 0700', () => {
    const pasta = mkdtempSync(join(tmpdir(), 'tower-db-'));
    pastas.push(pasta);
    const file = join(pasta, 'sub', 'tower.db');
    const antes = process.umask(0o022);
    try {
      const db = abrir(file);
      db.run('INSERT INTO users (username, display_name, color, password_hash, created_at) VALUES (?, ?, ?, ?, ?)', 'ana', 'Ana', '#fff', 'h', 1);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(join(pasta, 'sub')).mode & 0o777).toBe(0o700);
      const extras = [`${file}-wal`, `${file}-shm`].filter((f) => existsSync(f));
      expect(extras.length).toBeGreaterThan(0);
      for (const f of extras) expect(statSync(f).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(antes);
    }
  });

  it('reabrir um banco 0644 o corrige para 0600; pasta já existente não muda', () => {
    const pasta = mkdtempSync(join(tmpdir(), 'tower-db-'));
    pastas.push(pasta);
    chmodSync(pasta, 0o755);
    const file = join(pasta, 'tower.db');
    abrir(file).close();
    chmodSync(file, 0o644);
    abrir(file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(pasta).mode & 0o777).toBe(0o755);
  });

  it('get de linha inexistente devolve undefined', () => {
    const db = abrir(':memory:');
    expect(db.get('SELECT id FROM users WHERE id = ?', 99)).toBeUndefined();
  });
});
