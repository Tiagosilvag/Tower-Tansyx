// Armazém dos usuários do Tower no SQLite. O hash da senha só sai por record()/recordById(): list() e get() nunca o devolvem.
import { tr } from '../../shared/i18n';
import type { Db } from '../db/db';

export interface User {
  id: number;
  username: string;
  displayName: string;
  color: string;
  createdAt: number;
  lastLoginAt?: number;
}

export interface UserRecord extends User {
  passwordHash: string;
}

export class UserError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = 'UserError';
  }
}

export const AVATAR_COLORS: readonly string[] = ['#fac665', '#7cc8ff', '#6fd69a', '#ff8a7a', '#c8a2ff', '#ffb3d9'];

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/i;

// O nome vira parte de caminhos e URLs, então só letras, números, ponto, hífen e sublinhado
export function usernameProblem(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !USERNAME_RE.test(raw.trim())) {
    return tr('o nome de usuário deve ter de 1 a 32 caracteres: letras, números, ponto, hífen ou sublinhado');
  }
  return undefined;
}

interface Row {
  id: number;
  username: string;
  display_name: string;
  color: string;
  password_hash: string;
  created_at: number;
  last_login_at: number | null;
}

function toUser(r: Row): User {
  const u: User = { id: r.id, username: r.username, displayName: r.display_name, color: r.color, createdAt: r.created_at };
  if (r.last_login_at !== null) u.lastLoginAt = r.last_login_at;
  return u;
}

function toRecord(r: Row): UserRecord {
  return { ...toUser(r), passwordHash: r.password_hash };
}

const COLS = 'id, username, display_name, color, password_hash, created_at, last_login_at';

export class UserStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  count(): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n ?? 0;
  }

  list(): User[] {
    return this.db.all<Row>(`SELECT ${COLS} FROM users ORDER BY id`).map(toUser);
  }

  get(id: number): User | undefined {
    const r = this.db.get<Row>(`SELECT ${COLS} FROM users WHERE id = ?`, id);
    return r && toUser(r);
  }

  record(username: string): UserRecord | undefined {
    const r = this.db.get<Row>(`SELECT ${COLS} FROM users WHERE username = ?`, username.trim());
    return r && toRecord(r);
  }

  recordById(id: number): UserRecord | undefined {
    const r = this.db.get<Row>(`SELECT ${COLS} FROM users WHERE id = ?`, id);
    return r && toRecord(r);
  }

  create(i: { username: string; displayName?: string; color?: string; passwordHash: string }): User {
    const problem = usernameProblem(i.username);
    if (problem) throw new UserError(400, problem);
    const username = i.username.trim().toLowerCase();
    // a checagem e o insert na mesma transação: dois cadastros simultâneos não furam a unicidade
    const id = this.db.transaction(() => {
      if (this.record(username)) throw new UserError(409, tr('já existe um usuário com esse nome'));
      const displayName = i.displayName?.trim() || username;
      const color = i.color ?? AVATAR_COLORS[this.count() % AVATAR_COLORS.length]!;
      return this.db.run(
        'INSERT INTO users (username, display_name, color, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
        username,
        displayName,
        color,
        i.passwordHash,
        this.now(),
      ).lastInsertRowid;
    });
    return this.get(id)!;
  }

  setPasswordHash(id: number, hash: string): void {
    const r = this.db.run('UPDATE users SET password_hash = ? WHERE id = ?', hash, id);
    if (r.changes === 0) throw new UserError(404, tr('usuário não encontrado'));
  }

  remove(id: number): void {
    this.db.transaction(() => {
      if (!this.get(id)) throw new UserError(404, tr('usuário não encontrado'));
      // sem usuários ninguém conseguiria entrar de novo
      if (this.count() <= 1) throw new UserError(409, tr('não dá para remover o único usuário'));
      this.db.run('DELETE FROM users WHERE id = ?', id);
    });
  }

  touchLogin(id: number): void {
    this.db.run('UPDATE users SET last_login_at = ? WHERE id = ?', this.now(), id);
  }
}
