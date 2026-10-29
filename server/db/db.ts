// Camada fina sobre o SQLite embutido no Node (node:sqlite). Todo acesso ao banco do projeto passa por aqui,
// para poder trocar de implementação sem mexer no resto.
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
  // Kanban: quadros (o Geral nasce aqui), cartões e o histórico de quem mexeu. Remover um usuário deixa tudo, com as
  // referências nulas; os nomes ficam gravados nas próprias linhas.
  `CREATE TABLE boards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('general', 'project')),
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    created_at INTEGER NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
  );
  INSERT INTO boards (kind, name, created_at) VALUES ('general', 'Geral', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  CREATE TABLE cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    column_key TEXT NOT NULL,
    position INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    priority TEXT NOT NULL,
    assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    project_id INTEGER REFERENCES boards(id) ON DELETE SET NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_by_name TEXT,
    created_via TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX cards_by_column ON cards (board_id, column_key, position);
  CREATE TABLE card_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    at INTEGER NOT NULL,
    actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    actor_name TEXT,
    via TEXT NOT NULL,
    kind TEXT NOT NULL,
    detail TEXT NOT NULL
  );
  CREATE INDEX card_events_by_card ON card_events (card_id, at)`,
];

/**
 * O banco guarda hashes de senha: só o dono lê. O arquivo nasce 0600 antes da primeira escrita (o SQLite cria o -wal e
 * o -shm com o modo dele) e um banco antigo 0644 é corrigido. A pasta só ganha 0700 quando é criada aqui: uma já
 * existente (~/.habblaud) guarda outras coisas e fica como está.
 */
function protect(file: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, '', { flag: 'a', mode: 0o600 });
  chmodSync(file, 0o600);
}

export function openDb(file: string): Db {
  if (file !== ':memory:') protect(file);
  const raw = new DatabaseSync(file);
  // sobras de uma abertura anterior, de antes desta proteção
  if (file !== ':memory:') for (const f of [`${file}-wal`, `${file}-shm`]) if (existsSync(f)) chmodSync(f, 0o600);
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
