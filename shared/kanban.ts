// Tipos e regras do Kanban que servidor e cliente compartilham (server/kanban/*, client/src/ui/kanban*).

export const COLUMNS = ['ideias', 'a_fazer', 'fazendo', 'revisao', 'feito'] as const;
export type Column = (typeof COLUMNS)[number];
export const PRIORITIES = ['alta', 'media', 'baixa'] as const;
export type Priority = (typeof PRIORITIES)[number];
/** Quem digitou: o próprio usuário pela página, ou um agente a pedido dele. */
export type Via = 'user' | 'agent';

export const MAX_TITLE = 200;
export const MAX_DESCRIPTION = 5000;
export const MAX_BOARD_NAME = 60;
export const MAX_COMMENT = 2000;
/** Arquivos anexados por cartão e tamanho de cada um (o mesmo teto dos outros anexos do Habblaud). */
export const MAX_FILES_PER_CARD = 20;

export interface KanbanBoard {
  id: number;
  kind: 'general' | 'project';
  name: string;
  /** Cartões fora da coluna "feito". */
  openCount: number;
}

export interface KanbanCard {
  id: number;
  boardId: number;
  column: Column;
  position: number;
  title: string;
  description: string;
  priority: Priority;
  assigneeId: number | null;
  /** Nome de usuário do responsável (para mostrar sem precisar da lista de usuários). */
  assigneeName: string | null;
  /** Nome de exibição e cor do responsável (o cartão mostra o avatar na cor dele). Ausentes sem responsável. */
  assigneeDisplayName?: string | null;
  assigneeColor?: string | null;
  /** Quantos arquivos estão anexados ao cartão. */
  fileCount?: number;
  /** Etiqueta de projeto (só no Geral). */
  projectId: number | null;
  createdBy: number | null;
  createdByName: string | null;
  createdVia: Via;
  createdAt: number;
  updatedAt: number;
}

/** Arquivo anexado a um cartão. O conteúdo vem de GET /api/kanban/files/:id; o caminho no disco nunca sai do servidor. */
export interface KanbanFile {
  id: number;
  cardId: number;
  name: string;
  /** Tipo informado no envio (só para mostrar; o servidor decide como entregar). */
  type: string;
  size: number;
  userId: number | null;
  userName: string | null;
  createdAt: number;
}

export type KanbanEventKind = 'created' | 'edited' | 'moved' | 'priority' | 'assigned' | 'tagged' | 'comment' | 'moved_board' | 'attached' | 'detached';

export interface KanbanEvent {
  id: number;
  cardId: number;
  at: number;
  actorId: number | null;
  actorName: string | null;
  via: Via;
  kind: KanbanEventKind;
  detail: string;
}

/** Texto para comparar na busca: minúsculas, sem acento e aparado. */
export function normalizeText(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}
