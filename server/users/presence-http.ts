// Rotas da presença (modo de usuários):
//   POST /api/presence  {agents: string[], typing?: string, leave?: true}: 204. Só com login (sem usuário: 204 sem efeito).
//   GET  /api/presence                                                    : 200 {presence: {agentId: PresentUser[]}}
// Sem login (porta local) ninguém tem nome: a lista fica vazia e a página não mostra nada.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tr } from '../../shared/i18n';
import { userOf } from './identity';
import type { Presence } from './presence';

export function createPresenceRoutes(opts: {
  presence: Presence;
  readJson: (req: IncomingMessage) => Promise<unknown>;
}): (req: IncomingMessage, res: ServerResponse) => boolean {
  const json = (res: ServerResponse, status: number, body?: unknown) => {
    const base = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (body === undefined) {
      res.writeHead(status, base);
      return void res.end();
    }
    const data = JSON.stringify(body);
    res.writeHead(status, { ...base, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) });
    res.end(data);
  };

  return (req, res) => {
    const method = req.method ?? 'GET';
    if (method === 'GET' || method === 'HEAD') {
      json(res, 200, { presence: userOf(req) ? opts.presence.snapshot() : {} });
      return true;
    }
    if (method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      json(res, 405, { error: tr('método não permitido') });
      return true;
    }
    opts.readJson(req).then(
      (raw) => {
        const user = userOf(req);
        if (user) {
          const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
          if (body.leave === true) opts.presence.leave(user.id);
          else opts.presence.beat(user, body.agents, body.typing);
        }
        json(res, 204);
      },
      () => json(res, 400, { error: tr('corpo inválido') }),
    );
    return true;
  };
}
