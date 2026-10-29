import { describe, expect, it } from 'vitest';
import type { KanbanBoard, KanbanCard, KanbanEvent } from '../../shared/kanban';
import { formatBoards, formatCard, formatCards, parseCommand, resolveBoard } from './cli';

describe('parseCommand', () => {
  it('boards e show', () => {
    expect(parseCommand(['boards'])).toEqual({ action: 'boards', json: false });
    expect(parseCommand(['show', '12'])).toEqual({ action: 'show', id: 12, json: false });
  });

  it('list com --q, e --json em qualquer posição', () => {
    expect(parseCommand(['list', 'Geral', '--q', 'celular'])).toEqual({ action: 'list', board: 'Geral', q: 'celular', json: false });
    expect(parseCommand(['--json', 'list', 'Tower Tansyx'])).toEqual({ action: 'list', board: 'Tower Tansyx', json: true });
  });

  it('add com título com espaços e todas as opções', () => {
    expect(parseCommand(['add', 'Geral', 'Título com espaços', '--col', 'a_fazer', '--prio', 'alta', '--desc', 'texto', '--as', 'tiago'])).toEqual({
      action: 'add',
      board: 'Geral',
      title: 'Título com espaços',
      column: 'a_fazer',
      priority: 'alta',
      description: 'texto',
      as: 'tiago',
      json: false,
    });
  });

  it('aceita coluna e prioridade escritas de forma frouxa (acento, espaço, hífen, caixa)', () => {
    expect(parseCommand(['add', 'Geral', 't', '--col', 'A fazer', '--prio', 'Média'])).toMatchObject({ column: 'a_fazer', priority: 'media' });
    expect(parseCommand(['move', '3', 'a-fazer'])).toMatchObject({ column: 'a_fazer' });
  });

  it('move, comment e edit', () => {
    expect(parseCommand(['move', '12', 'fazendo', '--as', 'tiago'])).toEqual({ action: 'move', id: 12, column: 'fazendo', as: 'tiago', json: false });
    expect(parseCommand(['move', '12', 'feito', '--pos', '0'])).toMatchObject({ position: 0 });
    expect(parseCommand(['comment', '12', 'texto longo'])).toEqual({ action: 'comment', id: 12, text: 'texto longo', json: false });
    expect(parseCommand(['edit', '12', '--prio', 'baixa', '--title', 'novo'])).toEqual({ action: 'edit', id: 12, priority: 'baixa', title: 'novo', json: false });
  });

  it('erros em português: ação desconhecida, coluna e prioridade inválidas, id não numérico, falta de argumento', () => {
    expect(parseCommand([])).toMatchObject({ error: expect.stringContaining('uso') });
    expect(parseCommand(['voar'])).toMatchObject({ error: expect.stringContaining('voar') });
    expect(parseCommand(['move', '12', 'nada'])).toMatchObject({ error: expect.stringContaining('coluna') });
    expect(parseCommand(['add', 'Geral', 't', '--prio', 'urgente'])).toMatchObject({ error: expect.stringContaining('prioridade') });
    expect(parseCommand(['show', 'abc'])).toMatchObject({ error: expect.stringContaining('id') });
    expect(parseCommand(['add', 'Geral'])).toMatchObject({ error: expect.any(String) });
    expect(parseCommand(['list', 'Geral', '--q'])).toMatchObject({ error: expect.any(String) });
    expect(parseCommand(['edit', '12'])).toMatchObject({ error: expect.any(String) });
  });
});

const boards: KanbanBoard[] = [
  { id: 1, kind: 'general', name: 'Geral', openCount: 2 },
  { id: 5, kind: 'project', name: 'Tower Tansyx', openCount: 7 },
];

describe('resolveBoard', () => {
  it('acha por nome sem diferenciar caixa nem acento, ou por id; desconhecido é undefined', () => {
    expect(resolveBoard(boards, 'geral')?.id).toBe(1);
    expect(resolveBoard(boards, ' TOWER tansyx ')?.id).toBe(5);
    expect(resolveBoard(boards, '5')?.id).toBe(5);
    expect(resolveBoard(boards, 'nada')).toBeUndefined();
  });
});

const card = (over: Partial<KanbanCard> = {}): KanbanCard => ({
  id: 12, boardId: 1, column: 'fazendo', position: 0, title: 'Revisão final', description: 'detalhe', priority: 'alta', assigneeId: null, assigneeName: null, projectId: null,
  createdBy: 1, createdByName: 'tiago', createdVia: 'agent', createdAt: 1, updatedAt: 1, ...over,
});

describe('formatação', () => {
  it('formatBoards lista nome e abertos, o Geral primeiro', () => {
    expect(formatBoards(boards).split('\n')).toEqual(['Geral (2 abertos)', 'Tower Tansyx (7 abertos)']);
  });

  it('formatCards: uma linha por cartão, com id, coluna, prioridade, título e autor com a marca via agente', () => {
    expect(formatCards([card(), card({ id: 13, title: 'Outro', createdVia: 'user', createdByName: null, column: 'a_fazer', priority: 'baixa' })]).split('\n')).toEqual([
      '#12 [fazendo] (alta) Revisão final — por tiago (via agente)',
      '#13 [a_fazer] (baixa) Outro',
    ]);
    expect(formatCards([])).toBe('Nenhum cartão.');
  });

  it('formatCard mostra os campos e o histórico', () => {
    const events: KanbanEvent[] = [{ id: 1, cardId: 12, at: Date.UTC(2026, 9, 29, 3, 41), actorId: 1, actorName: 'tiago', via: 'agent', kind: 'created', detail: 'Revisão final' }];
    const out = formatCard(card(), events);
    expect(out).toContain('#12 Revisão final');
    expect(out).toContain('detalhe');
    expect(out).toContain('created');
    expect(out).toContain('tiago (via agente)');
  });
});
