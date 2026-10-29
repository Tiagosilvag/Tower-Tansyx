import { describe, expect, it } from 'vitest';
import type { UserInfo } from '../../../shared/types';
import { initialOf, passwordProblem, userRowLabel } from './users-model';

const user = (patch: Partial<UserInfo> = {}): UserInfo => ({ id: 2, username: 'maria', displayName: 'Maria', color: '#7cc8ff', createdAt: 1_000, ...patch });

describe('initialOf', () => {
  it('primeira letra maiúscula', () => {
    expect(initialOf('tiago')).toBe('T');
    expect(initialOf('  ana')).toBe('A');
  });
  it('? quando vazio', () => {
    expect(initialOf('  ')).toBe('?');
    expect(initialOf('')).toBe('?');
  });
});

describe('passwordProblem', () => {
  it('curta demais', () => {
    expect(passwordProblem('123456789', '123456789')).toBe('A senha precisa ter pelo menos 10 caracteres.');
  });
  it('diferentes', () => {
    expect(passwordProblem('abcdefghij', 'abcdefghik')).toBe('As senhas não são iguais.');
  });
  it('válida', () => {
    expect(passwordProblem('abcdefghij', 'abcdefghij')).toBeUndefined();
  });
});

describe('userRowLabel', () => {
  const now = 10_000_000;
  it('marca você e mostra "agora"', () => {
    const r = userRowLabel(user({ id: 1, lastLoginAt: now - 3_600_000 }), now, 1);
    expect(r.isMe).toBe(true);
    expect(r.name).toBe('Maria');
    expect(r.detail).toBe('maria · último acesso agora');
  });
  it('formata o último acesso dos outros', () => {
    const r = userRowLabel(user({ lastLoginAt: now - 3 * 60_000 }), now, 1);
    expect(r.isMe).toBe(false);
    expect(r.detail).toBe('maria · último acesso há 3 min');
  });
  it('nunca entrou', () => {
    expect(userRowLabel(user(), now, 1).detail).toBe('maria · último acesso nunca');
  });
});
