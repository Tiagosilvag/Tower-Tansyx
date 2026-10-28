import { describe, expect, it } from 'vitest';
import { refreshSummary } from './usagerefresh';

describe('refreshSummary', () => {
  it('tudo certo: uma conta ou várias', () => {
    expect(refreshSummary([{ account: 'a', ok: true }])).toEqual({ text: 'Uso atualizado.', failed: false });
    expect(refreshSummary([{ account: 'a', ok: true }, { account: 'b', ok: true }])).toEqual({ text: 'Uso de 2 contas atualizado.', failed: false });
  });

  it('falhou em todas ou em parte: diz qual conta e por quê', () => {
    const all = refreshSummary([{ account: 'a', name: 'Conta A', ok: false, error: 'sem plano' }]);
    expect(all).toEqual({ text: 'Não deu para atualizar: Conta A: sem plano', failed: true });
    const some = refreshSummary([{ account: 'a', ok: true }, { account: 'b', ok: false }]);
    expect(some).toEqual({ text: 'Atualizado, menos: b: falhou', failed: true });
  });

  it('sem contas do Claude Code', () => {
    expect(refreshSummary([])).toEqual({ text: 'Nenhuma conta do Claude Code para atualizar.', failed: true });
  });
});
