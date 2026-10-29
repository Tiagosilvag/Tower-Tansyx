// Armazém do Kanban no SQLite: quadros (o Geral e um por projeto), cartões, e o histórico de quem mexeu em cada um.
// Mover e reordenar rodam em transação e renumeram as colunas como 0..n-1, então posições nunca repetem nem têm buraco.
import { tr } from '../../shared/i18n';
import {
  COLUMNS,
  MAX_BOARD_NAME,
  MAX_COMMENT,
  MAX_DESCRIPTION,
  MAX_FILES_PER_CARD,
  MAX_TITLE,
  normalizeText,
  PRIORITIES,
  type Column,
  type KanbanBoard,
  type KanbanCard,
  type KanbanEvent,
  type KanbanFile,
  type KanbanEventKind,
  type Priority,
  type Via,
} from '../../shared/kanban';
import type { Db } from '../db/db';

/** Quem fez a mudança: o usuário (ou nenhum) e o caminho (a própria pessoa ou um agente a pedido dela). */
export interface Actor {
  userId: number | null;
  name: string | null;
  via: Via;
}

export class KanbanError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = 'KanbanError';
  }
}

interface BoardRow {
  id: number;
  kind: 'general' | 'project';
  name: string;
}
interface CardRow {
  id: number;
  board_id: number;
  column_key: Column;
  position: number;
  title: string;
  description: string;
  priority: Priority;
  assignee_id: number | null;
  assignee_name: string | null;
  assignee_display_name: string | null;
  assignee_color: string | null;
  file_count: number;
  project_id: number | null;
  created_by: number | null;
  created_by_name: string | null;
  created_via: Via;
  created_at: number;
  updated_at: number;
}
interface FileRow {
  id: number;
  card_id: number;
  name: string;
  type: string;
  size: number;
  user_id: number | null;
  user_name: string | null;
  created_at: number;
}

const toFile = (r: FileRow): KanbanFile => ({ id: r.id, cardId: r.card_id, name: r.name, type: r.type, size: r.size, userId: r.user_id, userName: r.user_name, createdAt: r.created_at });

interface EventRow {
  id: number;
  card_id: number;
  at: number;
  actor_id: number | null;
  actor_name: string | null;
  via: Via;
  kind: KanbanEventKind;
  detail: string;
}

const CARD_COLS = 'id, board_id, column_key, position, title, description, priority, assignee_id, (SELECT username FROM users WHERE users.id = cards.assignee_id) AS assignee_name, (SELECT display_name FROM users WHERE users.id = cards.assignee_id) AS assignee_display_name, (SELECT color FROM users WHERE users.id = cards.assignee_id) AS assignee_color, (SELECT COUNT(*) FROM card_files WHERE card_files.card_id = cards.id) AS file_count, project_id, created_by, created_by_name, created_via, created_at, updated_at';

const toCard = (r: CardRow): KanbanCard => ({
  id: r.id,
  boardId: r.board_id,
  column: r.column_key,
  position: r.position,
  title: r.title,
  description: r.description,
  priority: r.priority,
  assigneeId: r.assignee_id,
  assigneeName: r.assignee_name,
  assigneeDisplayName: r.assignee_display_name,
  assigneeColor: r.assignee_color,
  fileCount: r.file_count,
  projectId: r.project_id,
  createdBy: r.created_by,
  createdByName: r.created_by_name,
  createdVia: r.created_via,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toEvent = (r: EventRow): KanbanEvent => ({ id: r.id, cardId: r.card_id, at: r.at, actorId: r.actor_id, actorName: r.actor_name, via: r.via, kind: r.kind, detail: r.detail });

function boardName(raw: string): string {
  const name = raw.trim();
  if (!name) throw new KanbanError(400, tr('o nome do projeto não pode ficar em branco'));
  if (name.length > MAX_BOARD_NAME) throw new KanbanError(400, tr('o nome do projeto passa de {0} caracteres', [MAX_BOARD_NAME]));
  return name;
}

function titleOf(raw: string): string {
  const title = raw.trim();
  if (!title) throw new KanbanError(400, tr('o título não pode ficar em branco'));
  if (title.length > MAX_TITLE) throw new KanbanError(400, tr('o título passa de {0} caracteres', [MAX_TITLE]));
  return title;
}

function descriptionOf(raw: string): string {
  if (raw.length > MAX_DESCRIPTION) throw new KanbanError(400, tr('a descrição passa de {0} caracteres', [MAX_DESCRIPTION]));
  return raw;
}

function columnOf(raw: string): Column {
  if (!(COLUMNS as readonly string[]).includes(raw)) throw new KanbanError(400, tr('coluna inválida'));
  return raw as Column;
}

function priorityOf(raw: string): Priority {
  if (!(PRIORITIES as readonly string[]).includes(raw)) throw new KanbanError(400, tr('prioridade inválida'));
  return raw as Priority;
}

export class KanbanStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  boards(): KanbanBoard[] {
    const rows = this.db.all<BoardRow & { open: number }>(
      `SELECT b.id, b.kind, b.name, (SELECT COUNT(*) FROM cards c WHERE c.board_id = b.id AND c.column_key != 'feito') AS open
       FROM boards b ORDER BY (b.kind = 'general') DESC, b.name COLLATE NOCASE`,
    );
    return rows.map((r) => ({ id: r.id, kind: r.kind, name: r.name, openCount: r.open }));
  }

  createBoard(name: string, actor: Actor): KanbanBoard {
    const clean = boardName(name);
    if (this.db.get('SELECT id FROM boards WHERE name = ?', clean)) throw new KanbanError(409, tr('já existe um projeto com esse nome'));
    const { lastInsertRowid } = this.db.run("INSERT INTO boards (kind, name, created_at, created_by) VALUES ('project', ?, ?, ?)", clean, this.now(), actor.userId);
    return { id: lastInsertRowid, kind: 'project', name: clean, openCount: 0 };
  }

  renameBoard(id: number, name: string, _actor: Actor): KanbanBoard {
    const board = this.board(id);
    if (board.kind === 'general') throw new KanbanError(400, tr('o quadro Geral não pode ser renomeado'));
    const clean = boardName(name);
    const clash = this.db.get<{ id: number }>('SELECT id FROM boards WHERE name = ?', clean);
    if (clash && clash.id !== id) throw new KanbanError(409, tr('já existe um projeto com esse nome'));
    this.db.run('UPDATE boards SET name = ? WHERE id = ?', clean, id);
    return this.boards().find((b) => b.id === id)!;
  }

  deleteBoard(id: number, force: boolean): void {
    const board = this.board(id);
    if (board.kind === 'general') throw new KanbanError(400, tr('o quadro Geral não pode ser removido'));
    const n = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM cards WHERE board_id = ?', id)?.n ?? 0;
    if (n > 0 && !force) throw new KanbanError(409, tr('o projeto tem cartões: confirme para apagá-los junto'));
    this.db.run('DELETE FROM boards WHERE id = ?', id);
  }

  cards(boardId: number, q = ''): KanbanCard[] {
    const rows = this.db.all<CardRow>(
      `SELECT ${CARD_COLS} FROM cards WHERE board_id = ?
       ORDER BY CASE column_key WHEN 'ideias' THEN 0 WHEN 'a_fazer' THEN 1 WHEN 'fazendo' THEN 2 ELSE 3 END, position`,
      boardId,
    );
    const needle = normalizeText(q);
    const all = rows.map(toCard);
    return needle ? all.filter((c) => normalizeText(`${c.title}\n${c.description}`).includes(needle)) : all;
  }

  card(id: number): KanbanCard | undefined {
    const r = this.db.get<CardRow>(`SELECT ${CARD_COLS} FROM cards WHERE id = ?`, id);
    return r && toCard(r);
  }

  events(cardId: number): KanbanEvent[] {
    return this.db.all<EventRow>('SELECT id, card_id, at, actor_id, actor_name, via, kind, detail FROM card_events WHERE card_id = ? ORDER BY at DESC, id DESC', cardId).map(toEvent);
  }

  createCard(
    boardId: number,
    input: { title: string; description?: string; priority?: Priority; column?: Column; assigneeId?: number | null; projectId?: number | null },
    actor: Actor,
  ): KanbanCard {
    const board = this.board(boardId);
    const title = titleOf(input.title);
    const description = descriptionOf(input.description ?? '');
    const priority = priorityOf(input.priority ?? 'media');
    const column = columnOf(input.column ?? 'ideias');
    const assigneeId = input.assigneeId ?? null;
    if (assigneeId !== null) this.requireUser(assigneeId);
    const projectId = input.projectId ?? null;
    if (projectId !== null) this.requireTag(board, projectId);
    return this.db.transaction(() => {
      const position = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM cards WHERE board_id = ? AND column_key = ?', boardId, column)?.n ?? 0;
      const at = this.now();
      const { lastInsertRowid } = this.db.run(
        `INSERT INTO cards (board_id, column_key, position, title, description, priority, assignee_id, project_id, created_by, created_by_name, created_via, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        boardId, column, position, title, description, priority, assigneeId, projectId, actor.userId, actor.name, actor.via, at, at,
      );
      this.log(lastInsertRowid, actor, 'created', title);
      return this.card(lastInsertRowid)!;
    });
  }

  updateCard(
    id: number,
    patch: { title?: string; description?: string; priority?: Priority; assigneeId?: number | null; projectId?: number | null },
    actor: Actor,
  ): KanbanCard {
    const card = this.requireCard(id);
    const next = { ...card };
    const edited: string[] = [];
    if (patch.title !== undefined) {
      next.title = titleOf(patch.title);
      if (next.title !== card.title) edited.push('title');
    }
    if (patch.description !== undefined) {
      next.description = descriptionOf(patch.description);
      if (next.description !== card.description) edited.push('description');
    }
    if (patch.priority !== undefined) next.priority = priorityOf(patch.priority);
    if (patch.assigneeId !== undefined) {
      if (patch.assigneeId !== null) this.requireUser(patch.assigneeId);
      next.assigneeId = patch.assigneeId;
    }
    if (patch.projectId !== undefined) {
      if (patch.projectId !== null) this.requireTag(this.board(card.boardId), patch.projectId);
      next.projectId = patch.projectId;
    }
    return this.db.transaction(() => {
      if (edited.length) this.log(id, actor, 'edited', edited.join(','));
      if (next.priority !== card.priority) this.log(id, actor, 'priority', `${card.priority}→${next.priority}`);
      if (next.assigneeId !== card.assigneeId) this.log(id, actor, 'assigned', next.assigneeId === null ? '—' : (this.userName(next.assigneeId) ?? '—'));
      if (next.projectId !== card.projectId) this.log(id, actor, 'tagged', next.projectId === null ? '—' : this.board(next.projectId).name);
      const changed = edited.length || next.priority !== card.priority || next.assigneeId !== card.assigneeId || next.projectId !== card.projectId;
      if (!changed) return card;
      this.db.run('UPDATE cards SET title = ?, description = ?, priority = ?, assignee_id = ?, project_id = ?, updated_at = ? WHERE id = ?', next.title, next.description, next.priority, next.assigneeId, next.projectId, this.now(), id);
      return this.card(id)!;
    });
  }

  moveCard(id: number, to: { column?: Column; position?: number; boardId?: number }, actor: Actor): KanbanCard {
    const card = this.requireCard(id);
    const destBoard = this.board(to.boardId ?? card.boardId);
    const column = columnOf(to.column ?? card.column);
    return this.db.transaction(() => {
      const boardChanged = destBoard.id !== card.boardId;
      const dest = this.column(destBoard.id, column).filter((c) => c !== id);
      const at = to.position === undefined ? dest.length : Math.min(Math.max(Math.trunc(to.position), 0), dest.length);
      dest.splice(at, 0, id);
      this.db.run('UPDATE cards SET board_id = ?, column_key = ?, project_id = ?, updated_at = ? WHERE id = ?', destBoard.id, column, boardChanged ? null : card.projectId, this.now(), id);
      this.renumber(dest);
      if (boardChanged || column !== card.column) this.renumber(this.column(card.boardId, card.column));
      if (boardChanged) this.log(id, actor, 'moved_board', `${this.board(card.boardId).name}→${destBoard.name}`);
      else if (column !== card.column) this.log(id, actor, 'moved', `${card.column}→${column}`);
      return this.card(id)!;
    });
  }

  comment(id: number, text: string, actor: Actor): KanbanEvent {
    this.requireCard(id);
    const clean = text.trim();
    if (!clean) throw new KanbanError(400, tr('o comentário não pode ficar em branco'));
    if (clean.length > MAX_COMMENT) throw new KanbanError(400, tr('o comentário passa de {0} caracteres', [MAX_COMMENT]));
    this.log(id, actor, 'comment', clean);
    return this.events(id)[0]!;
  }

  files(cardId: number): KanbanFile[] {
    return this.db.all<FileRow>('SELECT id, card_id, name, type, size, user_id, user_name, created_at FROM card_files WHERE card_id = ? ORDER BY id', cardId).map(toFile);
  }

  file(id: number): KanbanFile | undefined {
    const r = this.db.get<FileRow>('SELECT id, card_id, name, type, size, user_id, user_name, created_at FROM card_files WHERE id = ?', id);
    return r && toFile(r);
  }

  /** Registra o arquivo (os bytes são gravados por quem chama, com o id devolvido). */
  addFile(cardId: number, f: { name: string; type: string; size: number }, actor: Actor): KanbanFile {
    this.requireCard(cardId);
    return this.db.transaction(() => {
      const n = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM card_files WHERE card_id = ?', cardId)?.n ?? 0;
      if (n >= MAX_FILES_PER_CARD) throw new KanbanError(409, tr('o cartão já tem {0} arquivos: remova algum antes de anexar outro', [MAX_FILES_PER_CARD]));
      const at = this.now();
      const { lastInsertRowid } = this.db.run('INSERT INTO card_files (card_id, name, type, size, user_id, user_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', cardId, f.name, f.type, f.size, actor.userId, actor.name, at);
      this.db.run('UPDATE cards SET updated_at = ? WHERE id = ?', at, cardId);
      this.log(cardId, actor, 'attached', f.name);
      return this.file(lastInsertRowid)!;
    });
  }

  removeFile(id: number, actor: Actor): KanbanFile {
    const f = this.file(id);
    if (!f) throw new KanbanError(404, tr('arquivo não encontrado'));
    this.db.transaction(() => {
      this.db.run('DELETE FROM card_files WHERE id = ?', id);
      this.db.run('UPDATE cards SET updated_at = ? WHERE id = ?', this.now(), f.cardId);
      this.log(f.cardId, actor, 'detached', f.name);
    });
    return f;
  }

  deleteCard(id: number): void {
    const card = this.requireCard(id);
    this.db.transaction(() => {
      this.db.run('DELETE FROM cards WHERE id = ?', id);
      this.renumber(this.column(card.boardId, card.column));
    });
  }

  private board(id: number): BoardRow {
    const b = this.db.get<BoardRow>('SELECT id, kind, name FROM boards WHERE id = ?', id);
    if (!b) throw new KanbanError(404, tr('projeto não encontrado'));
    return b;
  }

  private requireCard(id: number): KanbanCard {
    const c = this.card(id);
    if (!c) throw new KanbanError(404, tr('cartão não encontrado'));
    return c;
  }

  private requireUser(id: number): void {
    if (!this.db.get('SELECT id FROM users WHERE id = ?', id)) throw new KanbanError(400, tr('responsável desconhecido'));
  }

  private userName(id: number): string | undefined {
    return this.db.get<{ username: string }>('SELECT username FROM users WHERE id = ?', id)?.username;
  }

  /** Etiqueta de projeto: o cartão tem de estar no Geral e o alvo ser um projeto. */
  private requireTag(board: BoardRow, projectId: number): void {
    if (board.kind !== 'general') throw new KanbanError(400, tr('só cartões do Geral levam etiqueta de projeto'));
    const target = this.db.get<BoardRow>('SELECT id, kind, name FROM boards WHERE id = ?', projectId);
    if (!target || target.kind !== 'project') throw new KanbanError(400, tr('a etiqueta precisa ser um projeto'));
  }

  /** Ids de uma coluna, na ordem das posições. */
  private column(boardId: number, column: Column): number[] {
    return this.db.all<{ id: number }>('SELECT id FROM cards WHERE board_id = ? AND column_key = ? ORDER BY position, id', boardId, column).map((r) => r.id);
  }

  private renumber(ids: number[]): void {
    ids.forEach((id, i) => this.db.run('UPDATE cards SET position = ? WHERE id = ?', i, id));
  }

  private log(cardId: number, actor: Actor, kind: KanbanEventKind, detail: string): void {
    this.db.run('INSERT INTO card_events (card_id, at, actor_id, actor_name, via, kind, detail) VALUES (?, ?, ?, ?, ?, ?, ?)', cardId, this.now(), actor.userId, actor.name, actor.via, kind, detail);
  }
}
