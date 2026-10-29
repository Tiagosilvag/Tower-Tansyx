// API de usuários do modo de usuários: o próprio perfil, a lista, o cadastro, a troca de senha e a remoção.
//
// Quem chama já passou pelo portão (server/http/remote.ts), que anota o usuário na requisição (identity.ts). Sem anotação
// (porta local, ou nenhum login) só GET /api/me responde, com `{user: null}`: é assim que a página esconde o chip.
// Nada aqui põe a identidade em coisa que chegue aos agentes do Claude.
//
// Dependências (Tarefa 8 monta em server/index.ts):
//   store, auth     o armazém e o login da Tarefa 2/3
//   readJson        o leitor de corpo JSON de http/app.ts (injetado, não há outro)
//   setCookie       o valor completo do Set-Cookie da sessão (a lógica do portão; `secure` se decide por requisição)
//   hash            opcional; o padrão é o scrypt de custo normal. Custo menor revelaria usuários reais pelo tempo da
//                   resposta, então só os testes injetam um hash barato.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError } from '../http/app';
import { hashPassword } from '../remote/password';
import { tr } from '../../shared/i18n';
import type { UserInfo } from '../../shared/types';
import type { UserAuth } from './auth';
import { userOf } from './identity';
import { usernameProblem, UserError, type User, type UserStore } from './store';

/** Mesmo mínimo do `npm run remote:setup`. */
export const MIN_PASSWORD = 10;

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const MAX_DISPLAY_NAME = 40;
const USER_PATH = /^\/api\/users\/([1-9]\d{0,15})(\/password)?$/;

export interface UsersRoutesDeps {
  store: UserStore;
  auth: UserAuth;
  readJson: (req: IncomingMessage) => Promise<unknown>;
  setCookie: (req: IncomingMessage, token: string, maxAgeS: number) => string;
  hash?: (password: string) => Promise<string>;
}

/** Erro com status HTTP e mensagem já traduzida (a validação e os UserError do armazém). */
class Reply extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
  const base = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers };
  if (body === undefined) {
    res.writeHead(status, base);
    res.end();
    return;
  }
  const data = JSON.stringify(body);
  res.writeHead(status, { ...base, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

// A resposta nunca carrega o hash: monta o objeto campo a campo em vez de repassar o que veio do armazém.
function info(u: User): UserInfo {
  const out: UserInfo = { id: u.id, username: u.username, displayName: u.displayName, color: u.color, createdAt: u.createdAt };
  if (u.lastLoginAt !== undefined) out.lastLoginAt = u.lastLoginAt;
  return out;
}

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Reply(400, tr('requisição inválida'));
  return body as Record<string, unknown>;
}

function checkPassword(password: unknown): string {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw new Reply(400, tr('use pelo menos {0} caracteres', [MIN_PASSWORD]));
  }
  return password;
}

export function createUsersRoutes(deps: UsersRoutesDeps): (req: IncomingMessage, res: ServerResponse, url: URL) => boolean {
  const { store, auth, readJson } = deps;
  const hash = deps.hash ?? ((p: string) => hashPassword(p));

  const sessionCookie = (req: IncomingMessage, userId: number): Record<string, string> => {
    const { token, maxAgeS } = auth.issueFor(userId);
    return { 'Set-Cookie': deps.setCookie(req, token, maxAgeS) };
  };

  async function create(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const b = asObject(await readJson(req));
    const problem = usernameProblem(b.username);
    if (problem) throw new Reply(400, problem);
    let displayName: string | undefined;
    if (b.displayName !== undefined) {
      displayName = typeof b.displayName === 'string' ? b.displayName.trim() : '';
      if (displayName.length < 1 || displayName.length > MAX_DISPLAY_NAME) {
        throw new Reply(400, tr('o nome de exibição deve ter de 1 a {0} caracteres', [MAX_DISPLAY_NAME]));
      }
    }
    if (b.color !== undefined && (typeof b.color !== 'string' || !COLOR_RE.test(b.color))) {
      throw new Reply(400, tr('a cor deve estar no formato #rrggbb'));
    }
    const password = checkPassword(b.password);
    const user = store.create({
      username: b.username as string,
      displayName,
      color: b.color as string | undefined,
      passwordHash: await hash(password),
    });
    send(res, 201, info(user));
  }

  async function setPassword(req: IncomingMessage, res: ServerResponse, me: User, id: number): Promise<void> {
    const password = checkPassword(asObject(await readJson(req)).password);
    store.setPasswordHash(id, await hash(password));
    // trocar a própria senha mata o token de quem trocou (a chave mistura o hash): entrega um novo junto
    send(res, 204, undefined, id === me.id ? sessionCookie(req, me.id) : {});
  }

  async function changeOwn(req: IncomingMessage, res: ServerResponse, me: User): Promise<void> {
    const b = asObject(await readJson(req));
    const password = checkPassword(b.password);
    // a conferência é o próprio login: usa a fila, o freio por usuário e o scrypt que roda sempre
    const check = await auth.login(me.username, b.currentPassword);
    if (!check.ok) {
      if (check.status === 429) {
        const wait = check.retryAfter ?? 1;
        throw new Reply(429, tr('Muitas tentativas. Tente de novo em {0} s.', [wait]), { 'Retry-After': String(wait) });
      }
      throw new Reply(403, tr('senha atual incorreta'));
    }
    store.setPasswordHash(me.id, await hash(password));
    send(res, 204, undefined, sessionCookie(req, me.id));
  }

  function remove(res: ServerResponse, me: User, id: number): void {
    if (id === me.id) throw new Reply(409, tr('você não pode remover o próprio usuário'));
    store.remove(id);
    send(res, 204);
  }

  return (req, res, url) => {
    const path = url.pathname;
    const idMatch = USER_PATH.exec(path);
    if (path !== '/api/me' && path !== '/api/users' && path !== '/api/me/password' && !idMatch) return false;
    const method = req.method ?? 'GET';

    const allowed = path === '/api/users' ? ['GET', 'POST'] : path === '/api/me' ? ['GET'] : idMatch && !idMatch[2] ? ['DELETE'] : ['POST'];
    if (!allowed.includes(method)) {
      req.resume();
      send(res, 405, { error: tr('método não permitido') }, { Allow: allowed.join(', ') });
      return true;
    }

    const me = userOf(req);
    if (path === '/api/me') {
      send(res, 200, { user: me ? info(me) : null });
      return true;
    }
    if (!me) {
      req.resume();
      send(res, 401, { error: tr('faça login') });
      return true;
    }

    const id = idMatch ? Number(idMatch[1]) : 0;
    let run: Promise<void> | undefined;
    if (path === '/api/users') {
      if (method === 'GET') send(res, 200, { users: store.list().map(info) });
      else run = create(req, res);
    } else if (path === '/api/me/password') run = changeOwn(req, res, me);
    else if (idMatch![2]) run = setPassword(req, res, me, id);
    else {
      req.resume();
      run = Promise.resolve().then(() => remove(res, me, id));
    }

    run?.catch((err: unknown) => {
      if (res.headersSent) return void res.end();
      if (err instanceof Reply) return send(res, err.status, { error: err.message }, err.headers);
      if (err instanceof UserError) return send(res, err.status, { error: err.message });
      // erros do leitor de corpo (415, 413, JSON inválido) já trazem status e texto traduzido
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      send(res, 500, { error: tr('erro interno') });
    });
    return true;
  };
}
