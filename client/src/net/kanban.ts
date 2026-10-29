// Chamadas à API do Kanban (/api/kanban/*). Um método por rota; o fetch, o erro com a mensagem do servidor e o redirecionamento
// para o login quando a sessão acaba são os de `usersApi` (ui/users.ts). O guard do servidor exige Content-Type JSON em todo
// pedido que não é GET, até o DELETE sem corpo: por isso os DELETE mandam `{}`.
import type { Column, KanbanBoard, KanbanCard, KanbanEvent, KanbanFile, Priority } from '../../../shared/kanban';
import { fileToBase64 } from '../ui/ptyapi';
import { usersApi } from '../ui/users';

const base = '/api/kanban';

export interface NewCard {
  title: string;
  description?: string;
  priority?: Priority;
  column?: Column;
  assigneeId?: number | null;
  projectId?: number | null;
}

export type CardPatch = Partial<Pick<NewCard, 'title' | 'description' | 'priority' | 'assigneeId' | 'projectId'>>;

export const kanbanApi = {
  version: async (): Promise<number> => (await usersApi<{ version: number }>(`${base}/version`)).version,
  boards: async (): Promise<KanbanBoard[]> => (await usersApi<{ boards: KanbanBoard[] }>(`${base}/boards`)).boards,
  cards: async (boardId: number, q = ''): Promise<KanbanCard[]> => (await usersApi<{ cards: KanbanCard[] }>(`${base}/boards/${boardId}/cards${q ? `?q=${encodeURIComponent(q)}` : ''}`)).cards,
  card: (id: number): Promise<{ card: KanbanCard; events: KanbanEvent[]; files?: KanbanFile[] }> => usersApi(`${base}/cards/${id}`),
  attach: async (cardId: number, file: File): Promise<KanbanFile> =>
    (await usersApi<{ file: KanbanFile }>(`${base}/cards/${cardId}/files`, { method: 'POST', body: { name: file.name || 'arquivo', type: file.type, data: await fileToBase64(file) } })).file,
  removeFile: (id: number): Promise<void> => usersApi(`${base}/files/${id}`, { method: 'DELETE', body: {} }),
  fileUrl: (id: number): string => `${base}/files/${id}`,
  createBoard: async (name: string): Promise<KanbanBoard> => (await usersApi<{ board: KanbanBoard }>(`${base}/boards`, { method: 'POST', body: { name } })).board,
  renameBoard: async (id: number, name: string): Promise<KanbanBoard> => (await usersApi<{ board: KanbanBoard }>(`${base}/boards/${id}`, { method: 'PATCH', body: { name } })).board,
  deleteBoard: (id: number, force = false): Promise<void> => usersApi(`${base}/boards/${id}${force ? '?force=1' : ''}`, { method: 'DELETE', body: {} }),
  createCard: async (boardId: number, input: NewCard): Promise<KanbanCard> => (await usersApi<{ card: KanbanCard }>(`${base}/boards/${boardId}/cards`, { method: 'POST', body: input })).card,
  updateCard: async (id: number, patch: CardPatch): Promise<KanbanCard> => (await usersApi<{ card: KanbanCard }>(`${base}/cards/${id}`, { method: 'PATCH', body: patch })).card,
  moveCard: async (id: number, to: { column?: Column; position?: number; boardId?: number }): Promise<KanbanCard> => (await usersApi<{ card: KanbanCard }>(`${base}/cards/${id}/move`, { method: 'POST', body: to })).card,
  comment: async (id: number, text: string): Promise<KanbanEvent> => (await usersApi<{ event: KanbanEvent }>(`${base}/cards/${id}/comments`, { method: 'POST', body: { text } })).event,
  deleteCard: (id: number): Promise<void> => usersApi(`${base}/cards/${id}`, { method: 'DELETE', body: {} }),
};
