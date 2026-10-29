import { mkdtempSync, rmSync } from 'node:fs';
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

  it('get de linha inexistente devolve undefined', () => {
    const db = abrir(':memory:');
    expect(db.get('SELECT id FROM users WHERE id = ?', 99)).toBeUndefined();
  });
});
