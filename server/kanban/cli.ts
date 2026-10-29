// npm run kanban: o Kanban pela linha de comando, para os agentes (e para quem prefere o terminal). Aqui ficam só as
// partes puras (ler os argumentos, achar o quadro, formatar a saída); scripts/kanban.ts faz as chamadas HTTP.
import { tr } from '../../shared/i18n';
import { COLUMNS, normalizeText, PRIORITIES, type Column, type KanbanBoard, type KanbanCard, type KanbanEvent, type Priority } from '../../shared/kanban';

export type Command =
  | { action: 'boards'; json: boolean }
  | { action: 'list'; board: string; q?: string; json: boolean }
  | { action: 'show'; id: number; json: boolean }
  | { action: 'add'; board: string; title: string; column?: Column; priority?: Priority; description?: string; as?: string; json: boolean }
  | { action: 'move'; id: number; column: Column; position?: number; comment?: string; as?: string; json: boolean }
  | { action: 'comment'; id: number; text: string; as?: string; json: boolean }
  | { action: 'edit'; id: number; title?: string; description?: string; priority?: Priority; as?: string; json: boolean };

export const USAGE = tr(`uso: npm run kanban -- <ação> [argumentos] [--json]
  boards
  list <quadro> [--q texto]
  show <id>
  add <quadro> "título" [--col coluna] [--prio prioridade] [--desc texto] [--as usuário]
  move <id> <coluna> [--pos n] [--comment "motivo"] [--as usuário]
  comment <id> "texto" [--as usuário]
  edit <id> [--title texto] [--desc texto] [--prio prioridade] [--as usuário]
Colunas: ideias, a_fazer, fazendo, revisao, feito. Prioridades: alta, media, baixa.
Ao mover um cartão para revisao, --comment com o motivo é obrigatório.
O quadro pode ser o nome (Geral, o nome de um projeto) ou o número. Use --as com o usuário que pediu a mudança.`);

const VALUE_FLAGS = new Set(['--q', '--col', '--prio', '--desc', '--as', '--title', '--pos', '--comment']);

const slug = (s: string) => normalizeText(s).replace(/[\s-]+/g, '_');

function column(raw: string): Column | undefined {
  const c = slug(raw);
  return (COLUMNS as readonly string[]).includes(c) ? (c as Column) : undefined;
}

function priority(raw: string): Priority | undefined {
  const p = normalizeText(raw);
  return (PRIORITIES as readonly string[]).includes(p) ? (p as Priority) : undefined;
}

function idOf(raw: string | undefined): number | undefined {
  return raw !== undefined && /^[1-9]\d{0,15}$/.test(raw) ? Number(raw) : undefined;
}

export function parseCommand(argv: string[]): Command | { error: string } {
  const pos: string[] = [];
  const flags = new Map<string, string>();
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--json') json = true;
    else if (VALUE_FLAGS.has(a)) {
      const v = argv[++i];
      if (v === undefined) return { error: tr('falta o valor de {0}', [a]) };
      flags.set(a, v);
    } else if (a.startsWith('--')) return { error: tr('opção desconhecida: {0}', [a]) };
    else pos.push(a);
  }
  const action = pos[0];
  if (!action) return { error: USAGE };
  const as = flags.get('--as');
  const withAs = as === undefined ? {} : { as };

  let col: Column | undefined;
  if (flags.has('--col') || action === 'move') {
    const raw = action === 'move' ? pos[2] : flags.get('--col');
    col = raw === undefined ? undefined : column(raw);
    if (raw !== undefined && !col) return { error: tr('coluna inválida: {0} (use {1})', [raw, COLUMNS.join(', ')]) };
  }
  let prio: Priority | undefined;
  if (flags.has('--prio')) {
    prio = priority(flags.get('--prio')!);
    if (!prio) return { error: tr('prioridade inválida: {0} (use {1})', [flags.get('--prio')!, PRIORITIES.join(', ')]) };
  }

  switch (action) {
    case 'boards':
      return { action, json };
    case 'list': {
      if (!pos[1]) return { error: tr('falta o quadro') };
      return { action, board: pos[1], ...(flags.has('--q') ? { q: flags.get('--q')! } : {}), json };
    }
    case 'show': {
      const id = idOf(pos[1]);
      return id === undefined ? { error: tr('o id do cartão precisa ser um número') } : { action, id, json };
    }
    case 'add': {
      if (!pos[1] || !pos[2]) return { error: tr('falta o quadro ou o título') };
      return {
        action,
        board: pos[1],
        title: pos[2],
        ...(col ? { column: col } : {}),
        ...(prio ? { priority: prio } : {}),
        ...(flags.has('--desc') ? { description: flags.get('--desc')! } : {}),
        ...withAs,
        json,
      };
    }
    case 'move': {
      const id = idOf(pos[1]);
      if (id === undefined) return { error: tr('o id do cartão precisa ser um número') };
      if (!col) return { error: tr('falta a coluna') };
      let position: number | undefined;
      if (flags.has('--pos')) {
        position = Number(flags.get('--pos'));
        if (!Number.isInteger(position) || position < 0) return { error: tr('--pos precisa ser um número inteiro, a partir de 0') };
      }
      const comment = flags.get('--comment')?.trim();
      // Quem manda um cartão para revisão diz por quê: o comentário vai junto, no mesmo comando.
      if (col === 'revisao' && !comment) return { error: tr('para mover para revisao, diga o motivo com --comment "..."') };
      return { action, id, column: col, ...(position === undefined ? {} : { position }), ...(comment ? { comment } : {}), ...withAs, json };
    }
    case 'comment': {
      const id = idOf(pos[1]);
      if (id === undefined) return { error: tr('o id do cartão precisa ser um número') };
      return pos[2] ? { action, id, text: pos[2], ...withAs, json } : { error: tr('falta o texto do comentário') };
    }
    case 'edit': {
      const id = idOf(pos[1]);
      if (id === undefined) return { error: tr('o id do cartão precisa ser um número') };
      const cmd: Command = {
        action,
        id,
        ...(flags.has('--title') ? { title: flags.get('--title')! } : {}),
        ...(flags.has('--desc') ? { description: flags.get('--desc')! } : {}),
        ...(prio ? { priority: prio } : {}),
        ...withAs,
        json,
      };
      return cmd.title === undefined && cmd.description === undefined && cmd.priority === undefined ? { error: tr('nada para editar: use --title, --desc ou --prio') } : cmd;
    }
    default:
      return { error: tr('ação desconhecida: {0}\n{1}', [action, USAGE]) };
  }
}

/** O quadro pelo nome (sem diferenciar caixa nem acento) ou pelo número. */
export function resolveBoard(boards: KanbanBoard[], ref: string): KanbanBoard | undefined {
  const key = normalizeText(ref);
  return boards.find((b) => normalizeText(b.name) === key) ?? boards.find((b) => String(b.id) === ref.trim());
}

export function formatBoards(boards: KanbanBoard[]): string {
  return boards.map((b) => tr('{0} ({1} abertos)', [b.name, b.openCount])).join('\n');
}

/** "por tiago (via agente)", só "via agente", ou nada. */
function author(name: string | null, via: 'user' | 'agent'): string {
  if (name) return tr('por {0}', [name]) + (via === 'agent' ? ` (${tr('via agente')})` : '');
  return via === 'agent' ? tr('via agente') : '';
}

export function formatCards(cards: KanbanCard[]): string {
  if (!cards.length) return tr('Nenhum cartão.');
  return cards
    .map((c) => {
      const by = author(c.createdByName, c.createdVia);
      return `#${c.id} [${c.column}] (${c.priority}) ${c.title}${by ? ` — ${by}` : ''}`;
    })
    .join('\n');
}

export function formatCard(card: KanbanCard, events: KanbanEvent[]): string {
  const by = author(card.createdByName, card.createdVia);
  const lines = [`#${card.id} ${card.title}`, `[${card.column}] (${card.priority})${by ? ` — ${by}` : ''}`];
  if (card.description) lines.push('', card.description);
  if (events.length) {
    lines.push('', tr('Histórico:'));
    for (const e of events) {
      const who = e.actorName ? `${e.actorName}${e.via === 'agent' ? ` (${tr('via agente')})` : ''}` : e.via === 'agent' ? tr('via agente') : '—';
      lines.push(`  ${new Date(e.at).toISOString().slice(0, 16).replace('T', ' ')} ${e.kind} — ${who} — ${e.detail}`);
    }
  }
  return lines.join('\n');
}
