// Camada fina sobre o SQLite embutido no Node (node:sqlite). Todo acesso ao banco do projeto passa por aqui,
// para poder trocar de implementação sem mexer no resto.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type SqlValue = string | number | null;

export interface Db {
  exec(sql: string): void;
  get<T>(sql: string, ...p: SqlValue[]): T | undefined;
  all<T>(sql: string, ...p: SqlValue[]): T[];
  run(sql: string, ...p: SqlValue[]): { changes: number; lastInsertRowid: number };
  transaction<T>(fn: () => T): T;
  close(): void;
}

// O índice i é a versão i+1 (guardada em PRAGMA user_version). Nunca edite uma migração já publicada: acrescente outra.
export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    color TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER
  )`,
];

export function openDb(file: string): Db {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode = WAL');
  raw.exec('PRAGMA busy_timeout = 5000');
  raw.exec('PRAGMA foreign_keys = ON');

  const db: Db = {
    exec: (sql) => raw.exec(sql),
    get: <T>(sql: string, ...p: SqlValue[]) => raw.prepare(sql).get(...p) as T | undefined,
    all: <T>(sql: string, ...p: SqlValue[]) => raw.prepare(sql).all(...p) as T[],
    run: (sql, ...p) => {
      const r = raw.prepare(sql).run(...p);
      return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    },
    // IMMEDIATE pega a trava de escrita já no início, sem upgrade de leitura que falharia com SQLITE_BUSY
    transaction: <T>(fn: () => T): T => {
      raw.exec('BEGIN IMMEDIATE');
      try {
        const out = fn();
        raw.exec('COMMIT');
        return out;
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      }
    },
    close: () => raw.close(),
  };

  const atual = db.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0;
  for (let v = atual; v < MIGRATIONS.length; v++) {
    // cada migração e a nova versão entram juntas: uma falha no meio não deixa o banco pela metade
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
  return db;
}
