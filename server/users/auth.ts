// Login do modo de usuários: sessão que sabe quem é o usuário, freio por usuário e a conferência da senha.
//
// Token `v2.<id>.<validade>.<assinatura>`. A chave da assinatura mistura o segredo do servidor com o id e o hash da senha
// do usuário, lido a cada verify: trocar a senha ou remover o usuário derruba as sessões dele na hora, sem lista negra.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { RevokedTokens, SESSION_MS } from '../http/remote';
import { hashPassword, parsePasswordHash, verifyPassword, type PasswordHash } from '../remote/password';
import { tr } from '../../shared/i18n';
import type { User, UserStore } from './store';

const TOKEN_RE = /^v2\.([1-9]\d{0,15})\.(\d{10,16})\.([A-Za-z0-9_-]{43})$/;

export class UserSessions {
  private readonly revoked: RevokedTokens;

  constructor(
    private readonly secret: Buffer,
    private readonly lookup: (id: number) => { passwordHash: string } | undefined,
    private readonly now: () => number = Date.now,
    /** Onde a lista de tokens encerrados sobrevive a reinícios (ausente = só em memória). */
    revokedFile?: string,
  ) {
    this.revoked = new RevokedTokens(now, revokedFile);
  }

  /** Assinatura com a chave do usuário; undefined quando ele não existe mais. */
  private sign(id: number, payload: string): string | undefined {
    const user = this.lookup(id);
    if (!user) return undefined;
    const key = createHmac('sha256', this.secret).update(`${id}\0${user.passwordHash}`, 'utf8').digest();
    return createHmac('sha256', key).update(payload, 'utf8').digest('base64url');
  }

  issue(userId: number): { token: string; maxAgeS: number } {
    const payload = `v2.${userId}.${this.now() + SESSION_MS}`;
    const sig = this.sign(userId, payload);
    if (!sig) throw new Error(tr('usuário não encontrado'));
    return { token: `${payload}.${sig}`, maxAgeS: Math.floor(SESSION_MS / 1000) };
  }

  /** Id do usuário dono do token, ou undefined (inválido, vencido, encerrado, senha trocada, usuário removido). */
  verify(token: string | undefined): number | undefined {
    const parsed = this.parse(token);
    return parsed && !this.revoked.has(parsed.sig) ? parsed.id : undefined;
  }

  /** Encerra este token (botão "Sair"); token inválido ou vencido não muda nada. */
  revoke(token: string | undefined): void {
    const parsed = this.parse(token);
    if (parsed) this.revoked.add(parsed.sig, parsed.exp);
  }

  private parse(token: string | undefined): { id: number; exp: number; sig: string } | undefined {
    if (!token) return undefined;
    const m = TOKEN_RE.exec(token);
    if (!m) return undefined;
    const id = Number(m[1]);
    const exp = Number(m[2]);
    if (!Number.isSafeInteger(id) || exp <= this.now()) return undefined;
    const sig = this.sign(id, `v2.${m[1]}.${m[2]}`);
    if (!sig) return undefined;
    const expected = Buffer.from(sig);
    const got = Buffer.from(m[3]);
    return expected.length === got.length && timingSafeEqual(expected, got) ? { id, exp, sig: m[3] } : undefined;
  }
}

const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;
const GLOBAL_WINDOW_MS = 60_000;
const GLOBAL_MAX = 20;
const MAX_TRACKED = 1000;

interface Strikes {
  failures: number;
  lockedUntil: number;
  last: number;
}

function norm(username: string): string {
  return username.trim().toLowerCase();
}

/**
 * Freio de tentativas por usuário: 5 erros seguidos bloqueiam aquele nome por 15 min, para um atacante não trancar a
 * equipe toda errando senhas de nomes aleatórios. Nomes que não existem contam igual (o freio não revela quem existe).
 * Retaguarda global: mais de 20 erros em 60 s, de quaisquer nomes, fazem todos esperarem a janela baixar de 20.
 */
export class UserThrottle {
  private readonly users = new Map<string, Strikes>();
  /** Horários dos erros mais recentes: bastam os últimos GLOBAL_MAX + 1 para saber quando a janela baixa de 20. */
  private readonly recent: number[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  /** Segundos inteiros até este nome poder tentar de novo (0 = pode). */
  retryAfter(username: string): number {
    const now = this.now();
    const s = this.users.get(norm(username));
    let wait = s ? s.lockedUntil - now : 0;
    const inWindow = this.recent.filter((t) => t > now - GLOBAL_WINDOW_MS);
    if (inWindow.length > GLOBAL_MAX) wait = Math.max(wait, inWindow[inWindow.length - GLOBAL_MAX - 1]! + GLOBAL_WINDOW_MS - now);
    return wait > 0 ? Math.ceil(wait / 1000) : 0;
  }

  fail(username: string): void {
    const now = this.now();
    const name = norm(username);
    this.recent.push(now);
    if (this.recent.length > GLOBAL_MAX + 1) this.recent.shift();
    let s = this.users.get(name);
    if (s && this.expired(s, now)) s = undefined;
    if (!s) this.makeRoom(now);
    s ??= { failures: 0, lockedUntil: 0, last: 0 };
    s.failures++;
    s.last = now;
    if (s.failures >= MAX_FAILURES) {
      s.lockedUntil = now + LOCK_MS;
      s.failures = 0;
    }
    // reinsere no fim: a ordem do Map vira "mais antigo primeiro" para o despejo
    this.users.delete(name);
    this.users.set(name, s);
  }

  succeed(username: string): void {
    this.users.delete(norm(username));
  }

  /** Erros esquecidos 15 min depois do último, e o bloqueio quando vence. */
  private expired(s: Strikes, now: number): boolean {
    return s.lockedUntil <= now && s.last + LOCK_MS <= now;
  }

  /**
   * Abre espaço para um nome novo no teto de 1000: primeiro saem os vencidos, depois o mais antigo não bloqueado. Um
   * bloqueado só sai se todos estiverem bloqueados, e para bloquear 1000 nomes a retaguarda global (20 por minuto) faz
   * esperar bem mais que os 15 min: inundar o mapa com nomes não solta o bloqueio de ninguém.
   */
  private makeRoom(now: number): void {
    if (this.users.size < MAX_TRACKED) return;
    for (const [name, s] of this.users) if (this.expired(s, now)) this.users.delete(name);
    if (this.users.size < MAX_TRACKED) return;
    for (const [name, s] of this.users) {
      if (s.lockedUntil <= now) {
        this.users.delete(name);
        return;
      }
    }
    const oldest = this.users.keys().next();
    if (!oldest.done) this.users.delete(oldest.value);
  }
}

export type LoginResult = { ok: true; token: string; maxAgeS: number; user: User } | { ok: false; status: 401 | 429; retryAfter?: number };

/** Hash de enganação para nome inexistente: um scrypt de verdade, no custo padrão, para a conferência demorar o mesmo. */
let decoy: Promise<PasswordHash> | undefined;
function decoyHash(): Promise<PasswordHash> {
  if (!decoy) {
    decoy = hashPassword(randomBytes(16).toString('hex')).then((text) => parsePasswordHash(text)!);
    // falhou (sem memória para o scrypt, por exemplo): a próxima tentativa calcula de novo
    decoy.catch(() => (decoy = undefined));
  }
  return decoy;
}

export class UserAuth {
  /** Uma conferência por vez: scrypts em paralelo multiplicariam memória e CPU, e furariam o freio enquanto rodam. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: UserStore,
    private readonly sessions: UserSessions,
    private readonly throttle: UserThrottle,
    private readonly verify: (password: string, hash: PasswordHash) => Promise<boolean> = verifyPassword,
  ) {}

  login(username: unknown, password: unknown): Promise<LoginResult> {
    const name = typeof username === 'string' ? norm(username) : '';
    const pass = typeof password === 'string' ? password : '';
    const run = this.queue.then(() => this.attempt(name, pass));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async attempt(name: string, password: string): Promise<LoginResult> {
    // conferido dentro da fila: os erros de quem estava na frente já contam
    const retryAfter = this.throttle.retryAfter(name);
    if (retryAfter > 0) return { ok: false, status: 429, retryAfter };
    const record = name ? this.store.record(name) : undefined;
    const real = record && parsePasswordHash(record.passwordHash);
    // O scrypt roda sempre (sem atalho que denuncie se foi o usuário ou a senha que errou).
    let ok = false;
    try {
      ok = await this.verify(password, real ?? (await decoyHash()));
    } catch {
      ok = false;
    }
    if (!ok || !record || !real) {
      this.throttle.fail(name);
      return { ok: false, status: 401 };
    }
    this.throttle.succeed(name);
    this.store.touchLogin(record.id);
    const { token, maxAgeS } = this.sessions.issue(record.id);
    return { ok: true, token, maxAgeS, user: this.store.get(record.id)! };
  }

  userOf(token: string | undefined): User | undefined {
    const id = this.sessions.verify(token);
    return id === undefined ? undefined : this.store.get(id);
  }

  logout(token: string | undefined): void {
    this.sessions.revoke(token);
  }
}
