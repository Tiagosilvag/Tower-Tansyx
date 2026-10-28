import { describe, expect, it } from 'vitest';
import type { AccountInfo } from '../../../shared/types';
import { claudeAccounts, newSessionChoices } from './newsession';

const acc = (id: string, provider?: 'codex'): AccountInfo => ({ id, name: id, short: id[0], color: '#fff', configDir: `/${id}`, sessions: 0, usageStatus: 'disabled', ...(provider ? { provider } : {}) }) as AccountInfo;

describe('newSessionChoices', () => {
  it('lista só as contas do Claude Code, na ordem, e marca as que já têm agente principal na sala', () => {
    const accounts = [acc('c'), acc('cdx', 'codex'), acc('a')];
    const choices = newSessionChoices(accounts, [
      { account: 'c', provider: 'claude', kind: 'main' },
      { account: 'a', provider: 'claude', kind: 'sub' },
      { account: 'cdx', provider: 'codex', kind: 'main' },
    ]);
    expect(choices.map((c) => [c.account.id, c.inRoom])).toEqual([
      ['c', true],
      ['a', false],
    ]);
  });

  it('sala vazia: nenhuma marcada; uma conta só vira uma escolha só', () => {
    expect(newSessionChoices([acc('c')], []).map((c) => c.inRoom)).toEqual([false]);
    expect(claudeAccounts([acc('x', 'codex')])).toEqual([]);
  });
});
