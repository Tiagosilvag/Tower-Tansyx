// Login do modo de usuários: sessão que sabe quem é o usuário, freio por usuário e IP, e a conferência da senha.
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
const IP_WINDOW_MS = 60_000;
const IP_MAX = 20;
const NAME_WINDOW_MS = 60 * 60_000;
const NAME_MAX = 100;
const MAX_TRACKED = 1000;
/** Logins esperando a vez na fila: além disso, 429 na hora (a fila não cresce sem limite). */
const MAX_PENDING = 50;
/** IP de quem não se sabe de onde veio: ainda conta, só que todos juntos. */
export const UNKNOWN_IP = 'unknown';

interface Strikes {
  failures: number;
  lockedUntil: number;
  last: number;
}

function norm(username: string): string {
  return username.trim().toLowerCase();
}

/** Segundos até a janela baixar do teto: `times` guarda só os últimos `max + 1` erros, o mais antigo primeiro. */
function windowWait(times: number[] | undefined, now: number, windowMs: number, max: number): number {
  if (!times) return 0;
  const inWindow = times.filter((t) => t > now - windowMs);
  return inWindow.length > max ? inWindow[inWindow.length - max - 1]! + windowMs - now : 0;
}

function pushWindow(map: Map<string, number[]>, key: string, now: number, windowMs: number, max: number): void {
  const times = (map.get(key) ?? []).filter((t) => t > now - windowMs);
  times.push(now);
  if (times.length > max + 1) times.shift();
  // reinsere no fim: a ordem do Map vira "erro mais recente por último" para o despejo
  map.delete(key);
  map.set(key, times);
  if (map.size <= MAX_TRACKED) return;
  // teto: saem primeiro as janelas já vazias; se ainda não couber, a do erro mais antigo
  for (const [k, ts] of map) if (ts[ts.length - 1]! <= now - windowMs) map.delete(k);
  if (map.size > MAX_TRACKED) map.delete(map.keys().next().value!);
}

// \n não aparece num nome válido nem num IP: a chave não colide
function pairKey(name: string, ip: string): string {
  return `${ip}\n${name}`;
}

/**
 * Freio de tentativas, chaveado por quem tenta (o IP do cliente): sem isso, um anônimo errando senhas trancaria a
 * equipe toda, que é justamente o que o freio existe para evitar.
 *  - 5 erros seguidos do MESMO IP num nome bloqueiam aquele par (nome, IP) por 15 min; nomes que não existem contam
 *    igual (o freio não revela quem existe);
 *  - retaguarda por IP: mais de 20 erros em 60 s, de quaisquer nomes, fazem só aquele IP esperar;
 *  - teto folgado por nome: mais de 100 erros em 1 h, de todos os IPs juntos, seguram só aquele nome (contra chute
 *    distribuído; é o único freio que atravessa IPs).
 */
export class UserThrottle {
  private readonly pairs = new Map<string, Strikes>();
  /** Erros recentes por IP e por nome: bastam os últimos `max + 1` para saber quando a janela baixa do teto. */
  private readonly byIp = new Map<string, number[]>();
  private readonly byName = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Segundos inteiros até este nome, vindo deste IP, poder tentar de novo (0 = pode). */
  retryAfter(username: string, ip: string): number {
    const now = this.now();
    const name = norm(username);
    const s = this.pairs.get(pairKey(name, ip));
    const wait = Math.max(
      s ? s.lockedUntil - now : 0,
      windowWait(this.byIp.get(ip), now, IP_WINDOW_MS, IP_MAX),
      windowWait(this.byName.get(name), now, NAME_WINDOW_MS, NAME_MAX),
    );
    return wait > 0 ? Math.ceil(wait / 1000) : 0;
  }

  fail(username: string, ip: string): void {
    const now = this.now();
    const name = norm(username);
    const key = pairKey(name, ip);
    pushWindow(this.byIp, ip, now, IP_WINDOW_MS, IP_MAX);
    pushWindow(this.byName, name, now, NAME_WINDOW_MS, NAME_MAX);
    let s = this.pairs.get(key);
    if (s && this.expired(s, now)) s = undefined;
    if (!s) this.makeRoom(now);
    s ??= { failures: 0, lockedUntil: 0, last: 0 };
    s.failures++;
    s.last = now;
    if (s.failures >= MAX_FAILURES) {
      s.lockedUntil = now + LOCK_MS;
      s.failures = 0;
    }
    this.pairs.delete(key);
    this.pairs.set(key, s);
  }

  /** Acertou: zera o par. As janelas por IP e por nome ficam, senão um acerto apagaria os erros de outra pessoa. */
  succeed(username: string, ip: string): void {
    this.pairs.delete(pairKey(norm(username), ip));
  }

  /** Erros esquecidos 15 min depois do último, e o bloqueio quando vence. */
  private expired(s: Strikes, now: number): boolean {
    return s.lockedUntil <= now && s.last + LOCK_MS <= now;
  }

  /**
   * Abre espaço para um par novo no teto de 1000: primeiro saem os vencidos, depois o mais antigo não bloqueado. Um
   * bloqueado só sai se todos estiverem bloqueados, e para bloquear 1000 pares a retaguarda por IP (20 por minuto)
   * faz esperar bem mais que os 15 min: inundar o mapa de um IP só não solta o bloqueio de ninguém.
   */
  private makeRoom(now: number): void {
    if (this.pairs.size < MAX_TRACKED) return;
    for (const [key, s] of this.pairs) if (this.expired(s, now)) this.pairs.delete(key);
    if (this.pairs.size < MAX_TRACKED) return;
    for (const [key, s] of this.pairs) {
      if (s.lockedUntil <= now) {
        this.pairs.delete(key);
        return;
      }
    }
    const oldest = this.pairs.keys().next();
    if (!oldest.done) this.pairs.delete(oldest.value);
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
  private pending = 0;

  constructor(
    private readonly store: UserStore,
    private readonly sessions: UserSessions,
    private readonly throttle: UserThrottle,
    private readonly verify: (password: string, hash: PasswordHash) => Promise<boolean> = verifyPassword,
  ) {}

  /** `ip` é quem tenta (ver clientIp em http/remote.ts); o freio é por (nome, IP), por IP e, folgado, por nome. */
  login(username: unknown, password: unknown, ip?: string): Promise<LoginResult> {
    // fila cheia: recusa sem enfileirar nem contar erro (é carga, não chute de senha)
    if (this.pending >= MAX_PENDING) return Promise.resolve({ ok: false, status: 429, retryAfter: 1 });
    const name = typeof username === 'string' ? norm(username) : '';
    const pass = typeof password === 'string' ? password : '';
    const from = ip || UNKNOWN_IP;
    this.pending++;
    const run = this.queue.then(() => this.attempt(name, pass, from)).finally(() => this.pending--);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async attempt(name: string, password: string, ip: string): Promise<LoginResult> {
    // conferido dentro da fila: os erros de quem estava na frente já contam
    const retryAfter = this.throttle.retryAfter(name, ip);
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
      this.throttle.fail(name, ip);
      return { ok: false, status: 401 };
    }
    this.throttle.succeed(name, ip);
    this.store.touchLogin(record.id);
    const { token, maxAgeS } = this.sessions.issue(record.id);
    return { ok: true, token, maxAgeS, user: this.store.get(record.id)! };
  }

  /** Calcula o hash de enganação na subida: senão o primeiro login de nome inexistente demoraria dois scrypts. */
  warm(): Promise<void> {
    // falha aqui não derruba a subida: o login tenta calcular de novo
    return decoyHash().then(
      () => undefined,
      () => undefined,
    );
  }

  /** Sessão nova para quem já está autenticado (trocou a própria senha: o token antigo morreu com o hash antigo). */
  issueFor(userId: number): { token: string; maxAgeS: number } {
    return this.sessions.issue(userId);
  }

  userOf(token: string | undefined): User | undefined {
    const id = this.sessions.verify(token);
    return id === undefined ? undefined : this.store.get(id);
  }

  logout(token: string | undefined): void {
    this.sessions.revoke(token);
  }
}
