// API do Kanban (/api/kanban/*): quadros, cartões, mover e comentar. Serve a página e os agentes (npm run kanban).
//
// Autoria: pela porta remota o usuário da sessão manda, sempre (o portão anota em identity.ts; `as` e o cabeçalho de
// agente são ignorados). Na porta local, um agente manda `X-Habblaud-Via: agent` e `as` (nome de usuário, conferido contra
// os cadastrados; ausente ou desconhecido = sem usuário). A página local não tem login: sem usuário e via `user`.
// Nada aqui toca em terminal, spawn ou arquivos: as rotas só leem e escrevem no banco.
import { createReadStream } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tr } from '../../shared/i18n';
import type { Column, Priority } from '../../shared/kanban';
import { HttpError } from '../http/app';
import { ATTACHMENT_BODY_MAX, parseAttachment } from '../spawn/attachments';
import { isRemoteRequest } from '../http/remote';
import { userOf } from '../users/identity';
import type { UserStore } from '../users/store';
import { delivery, type KanbanFiles } from './files';
import { KanbanError, type Actor, type KanbanStore } from './store';

export interface KanbanRoutesDeps {
  store: KanbanStore;
  users?: UserStore;
  readJson: (req: IncomingMessage, max?: number) => Promise<unknown>;
  /** Arquivos anexados aos cartões (no disco). Ausente = anexos desligados: 404 nessas rotas. */
  files?: KanbanFiles;
  /** A requisição veio pela porta remota? (injetável nos testes; padrão: o marcador do portão). */
  isRemote?: (req: IncomingMessage) => boolean;
  /**
   * A porta local aceita escritas? Falso quando ela está exposta na rede (HABBLAUD_HOST ou o bind do Docker fora do loopback): aí
   * qualquer aparelho da rede chegaria sem login, e `as` o deixaria assinar como um usuário real. Padrão: aceita. Não vale
   * para a sessão remota logada (quem a protege é o portão).
   */
  writable?: (req: IncomingMessage) => boolean;
}

const ID_RE = /^[1-9]\d{0,15}$/;

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

function asObject(v: unknown): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new KanbanError(400, tr('corpo inválido'));
  return v as Record<string, unknown>;
}

function text(b: Record<string, unknown>, key: string, required = false): string | undefined {
  const v = b[key];
  if (v === undefined) {
    if (required) throw new KanbanError(400, tr('falta o campo {0}', [key]));
    return undefined;
  }
  if (typeof v !== 'string') throw new KanbanError(400, tr('o campo {0} precisa ser texto', [key]));
  return v;
}

function whole(b: Record<string, unknown>, key: string, nullable = false): number | null | undefined {
  const v = b[key];
  if (v === undefined) return undefined;
  if (v === null && nullable) return null;
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new KanbanError(400, tr('o campo {0} precisa ser um número inteiro', [key]));
  return v;
}

/** `undefined` quando o campo não veio; só tira o `null` do tipo, que os campos não anuláveis nunca devolvem. */
const num = (b: Record<string, unknown>, key: string): number | undefined => whole(b, key) as number | undefined;

export function createKanbanRoutes(deps: KanbanRoutesDeps): (req: IncomingMessage, res: ServerResponse, url: URL) => boolean {
  const { store, users, readJson, files } = deps;
  const isRemote = deps.isRemote ?? isRemoteRequest;
  const writable = deps.writable ?? (() => true);
  /**
   * Revisão do Kanban: sobe a cada alteração aceita (pela página, por outro usuário ou por um agente, tudo passa por aqui).
   * A página consulta e recarrega quando muda. Começa na hora de subida para nunca repetir um número depois de um reinício.
   */
  let revision = Date.now();

  /** Quem está agindo (ver o cabeçalho do arquivo). `body` é o corpo já lido, ou {} em GET e DELETE. */
  const actorOf = (req: IncomingMessage, body: Record<string, unknown>): Actor => {
    if (isRemote(req)) {
      const u = userOf(req);
      return { userId: u?.id ?? null, name: u?.username ?? null, via: 'user' };
    }
    if (req.headers['x-habblaud-via'] !== 'agent') return { userId: null, name: null, via: 'user' };
    const as = typeof body.as === 'string' ? body.as.trim() : '';
    const u = as ? users?.record(as) : undefined;
    return { userId: u?.id ?? null, name: u?.username ?? null, via: 'agent' };
  };

  return (req, res, url) => {
    const path = url.pathname;
    if (path !== '/api/kanban' && !path.startsWith('/api/kanban/')) return false;
    const method = req.method ?? 'GET';
    const seg = path.slice('/api/kanban/'.length).split('/').filter((s, i, a) => s !== '' || i < a.length - 1);
    const id = seg[1] !== undefined && ID_RE.test(seg[1]) ? Number(seg[1]) : undefined;
    if (method !== 'GET' && method !== 'HEAD' && !isRemote(req) && !writable(req)) {
      req.resume();
      send(res, 403, { error: tr('o Kanban só aceita alterações pelo próprio computador: a porta do Habblaud está exposta na rede') });
      return true;
    }

    if (method !== 'GET' && method !== 'HEAD') {
      res.on('finish', () => {
        if (res.statusCode < 400) revision++;
      });
    }

    /** Responde 405 quando o método não está na lista; devolve true quando respondeu. */
    const only = (...allowed: string[]): boolean => {
      if (allowed.includes(method)) return false;
      req.resume();
      send(res, 405, { error: tr('método não permitido') }, { Allow: allowed.join(', ') });
      return true;
    };
    const body = async (): Promise<Record<string, unknown>> => asObject(await readJson(req));
    const fail = (err: unknown): void => {
      if (res.headersSent) return void res.end();
      if (err instanceof KanbanError || err instanceof HttpError) return send(res, err.status, { error: err.message });
      send(res, 500, { error: tr('erro interno') });
    };
    const run = (fn: () => Promise<void> | void): true => {
      Promise.resolve()
        .then(fn)
        .catch(fail);
      return true;
    };
    const notFound = (): true => {
      req.resume();
      send(res, 404, { error: tr('rota desconhecida') });
      return true;
    };

    if (seg[0] === 'version' && seg.length === 1) {
      if (only('GET')) return true;
      return run(() => send(res, 200, { version: revision }));
    }
    if (seg[0] === 'boards' && seg.length === 1) {
      if (only('GET', 'POST')) return true;
      if (method === 'GET') return run(() => send(res, 200, { boards: store.boards() }));
      return run(async () => {
        const b = await body();
        send(res, 201, { board: store.createBoard(text(b, 'name', true)!, actorOf(req, b)) });
      });
    }
    if (seg[0] === 'boards' && id !== undefined && seg.length === 2) {
      if (only('PATCH', 'DELETE')) return true;
      if (method === 'DELETE') {
        req.resume();
        return run(() => {
          const cardIds = files ? store.cards(id).map((c) => c.id) : [];
          store.deleteBoard(id, url.searchParams.get('force') === '1');
          for (const c of cardIds) files?.removeCard(c);
          send(res, 204);
        });
      }
      return run(async () => {
        const b = await body();
        send(res, 200, { board: store.renameBoard(id, text(b, 'name', true)!, actorOf(req, b)) });
      });
    }
    if (seg[0] === 'boards' && id !== undefined && seg[2] === 'cards' && seg.length === 3) {
      if (only('GET', 'POST')) return true;
      if (method === 'GET') {
        req.resume();
        return run(() => {
          if (!store.boards().some((b) => b.id === id)) throw new KanbanError(404, tr('projeto não encontrado'));
          send(res, 200, { cards: store.cards(id, url.searchParams.get('q') ?? '') });
        });
      }
      return run(async () => {
        const b = await body();
        const actor = actorOf(req, b);
        // Sem responsável informado, o responsável é quem pediu o cartão (um `assigneeId: null` explícito deixa sem).
        const given = whole(b, 'assigneeId', true);
        const card = store.createCard(
          id,
          {
            title: text(b, 'title', true)!,
            description: text(b, 'description'),
            priority: text(b, 'priority') as Priority | undefined,
            column: text(b, 'column') as Column | undefined,
            assigneeId: given === undefined ? actor.userId : given,
            projectId: whole(b, 'projectId', true),
          },
          actor,
        );
        send(res, 201, { card });
      });
    }
    if (seg[0] === 'cards' && id !== undefined && seg.length === 2) {
      if (only('GET', 'PATCH', 'DELETE')) return true;
      if (method === 'PATCH') {
        return run(async () => {
          const b = await body();
          const card = store.updateCard(
            id,
            { title: text(b, 'title'), description: text(b, 'description'), priority: text(b, 'priority') as Priority | undefined, assigneeId: whole(b, 'assigneeId', true), projectId: whole(b, 'projectId', true) },
            actorOf(req, b),
          );
          send(res, 200, { card });
        });
      }
      req.resume();
      return run(() => {
        if (method === 'DELETE') {
          store.deleteCard(id);
          files?.removeCard(id);
          return send(res, 204);
        }
        const card = store.card(id);
        if (!card) throw new KanbanError(404, tr('cartão não encontrado'));
        send(res, 200, { card, events: store.events(id), files: store.files(id) });
      });
    }
    if (seg[0] === 'cards' && id !== undefined && seg[2] === 'move' && seg.length === 3) {
      if (only('POST')) return true;
      return run(async () => {
        const b = await body();
        send(res, 200, { card: store.moveCard(id, { column: text(b, 'column') as Column | undefined, position: num(b, 'position'), boardId: num(b, 'boardId') }, actorOf(req, b)) });
      });
    }
    if (seg[0] === 'cards' && id !== undefined && seg[2] === 'comments' && seg.length === 3) {
      if (only('POST')) return true;
      return run(async () => {
        const b = await body();
        send(res, 201, { event: store.comment(id, text(b, 'text', true)!, actorOf(req, b)) });
      });
    }
    if (seg[0] === 'cards' && id !== undefined && seg[2] === 'files' && seg.length === 3) {
      if (only('GET', 'POST')) return true;
      if (!files) return notFound();
      if (method === 'GET') {
        req.resume();
        return run(() => {
          if (!store.card(id)) throw new KanbanError(404, tr('cartão não encontrado'));
          send(res, 200, { files: store.files(id) });
        });
      }
      return run(async () => {
        const b = asObject(await readJson(req, ATTACHMENT_BODY_MAX));
        const a = parseAttachment(b);
        if ('error' in a) throw new KanbanError(400, a.error);
        const actor = actorOf(req, b);
        const file = store.addFile(id, { name: a.name, type: a.type, size: a.data.length }, actor);
        try {
          files.write(id, file.id, a.data);
        } catch {
          store.removeFile(file.id, actor);
          throw new HttpError(500, tr('não deu para gravar o arquivo no disco'));
        }
        send(res, 201, { file });
      });
    }
    if (seg[0] === 'files' && id !== undefined && seg.length === 2) {
      if (only('GET', 'DELETE')) return true;
      if (!files) return notFound();
      req.resume();
      return run(() => {
        const file = store.file(id);
        if (!file) throw new KanbanError(404, tr('arquivo não encontrado'));
        if (method === 'DELETE') {
          store.removeFile(id, actorOf(req, {}));
          files.remove(file.cardId, id);
          return send(res, 204);
        }
        const size = files.sizeOf(file.cardId, id);
        if (size === undefined) throw new KanbanError(404, tr('o arquivo sumiu do disco'));
        const how = delivery(file.name);
        res.writeHead(200, {
          'Content-Type': how.type,
          'Content-Length': size,
          'Content-Disposition': `${how.inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'private, no-store',
        });
        const stream = createReadStream(files.pathOf(file.cardId, id));
        stream.on('error', () => res.destroy());
        stream.pipe(res);
      });
    }
    return notFound();
  };
}
