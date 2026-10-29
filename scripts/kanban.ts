// npm run kanban -- <ação> ...: o Kanban pela linha de comando, para os agentes. Fala com o Habblaud local
// (http://127.0.0.1:<HABBLAUD_PORT ou 4747>) e se anuncia como agente, então toda escrita sai com a marca "via agente".
// Veja `npm run kanban` sem argumentos, ou docs/kanban-agentes.md.
import { pathToFileURL } from 'node:url';
import { formatBoards, formatCard, formatCards, parseCommand, resolveBoard, type Command } from '../server/kanban/cli';
import type { KanbanBoard, KanbanCard, KanbanEvent } from '../shared/kanban';
import { tr } from '../shared/i18n';

class CliError extends Error {}

export async function run(argv: string[], out: (s: string) => void, env: NodeJS.ProcessEnv = process.env, doFetch: typeof fetch = fetch): Promise<number> {
  const cmd = parseCommand(argv);
  if ('error' in cmd) {
    out(cmd.error);
    return 1;
  }
  const port = Number.parseInt(env.HABBLAUD_PORT ?? '', 10) || 4747;
  const base = `http://127.0.0.1:${port}/api/kanban`;
  const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    let res: Response;
    try {
      res = await doFetch(base + path, {
        method,
        headers: { 'X-Habblaud-Via': 'agent', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new CliError(tr('o Habblaud não respondeu em {0}', [`http://127.0.0.1:${port}`]));
    }
    const text = await res.text();
    const json = (text ? JSON.parse(text) : {}) as { error?: string };
    if (!res.ok) throw new CliError(json.error ?? tr('erro {0}', [res.status]));
    return json as T;
  };
  const board = async (ref: string): Promise<KanbanBoard> => {
    const found = resolveBoard((await api<{ boards: KanbanBoard[] }>('GET', '/boards')).boards, ref);
    if (!found) throw new CliError(tr('quadro desconhecido: {0} (veja npm run kanban -- boards)', [ref]));
    return found;
  };
  try {
    out(await execute(cmd, api, board));
    return 0;
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    out(err.message);
    return 1;
  }
}

async function execute(cmd: Command, api: <T>(m: string, p: string, b?: unknown) => Promise<T>, board: (ref: string) => Promise<KanbanBoard>): Promise<string> {
  const show = (data: unknown, text: () => string) => (cmd.json ? JSON.stringify(data, null, 2) : text());
  switch (cmd.action) {
    case 'boards': {
      const r = await api<{ boards: KanbanBoard[] }>('GET', '/boards');
      return show(r, () => formatBoards(r.boards));
    }
    case 'list': {
      const b = await board(cmd.board);
      const r = await api<{ cards: KanbanCard[] }>('GET', `/boards/${b.id}/cards${cmd.q ? `?q=${encodeURIComponent(cmd.q)}` : ''}`);
      return show(r, () => formatCards(r.cards));
    }
    case 'show': {
      const r = await api<{ card: KanbanCard; events: KanbanEvent[] }>('GET', `/cards/${cmd.id}`);
      return show(r, () => formatCard(r.card, r.events));
    }
    case 'add': {
      const b = await board(cmd.board);
      const r = await api<{ card: KanbanCard }>('POST', `/boards/${b.id}/cards`, { title: cmd.title, column: cmd.column, priority: cmd.priority, description: cmd.description, as: cmd.as });
      return show(r, () => tr('Criado: {0}', [formatCards([r.card])]));
    }
    case 'move': {
      const r = await api<{ card: KanbanCard }>('POST', `/cards/${cmd.id}/move`, { column: cmd.column, position: cmd.position, as: cmd.as });
      if (cmd.comment) await api('POST', `/cards/${cmd.id}/comments`, { text: cmd.comment, as: cmd.as });
      return show(r, () => tr('Movido: {0}', [formatCards([r.card])]));
    }
    case 'comment': {
      const r = await api<{ event: KanbanEvent }>('POST', `/cards/${cmd.id}/comments`, { text: cmd.text, as: cmd.as });
      return show(r, () => tr('Comentário gravado no cartão #{0}.', [cmd.id]));
    }
    case 'edit': {
      const r = await api<{ card: KanbanCard }>('PATCH', `/cards/${cmd.id}`, { title: cmd.title, description: cmd.description, priority: cmd.priority, as: cmd.as });
      return show(r, () => tr('Editado: {0}', [formatCards([r.card])]));
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2), (s) => console.log(s)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}

