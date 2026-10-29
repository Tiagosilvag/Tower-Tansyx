// Funções puras do chip e da administração de usuários (ui/usermenu.ts, ui/users.ts).
import { tr } from '../../../shared/i18n';
import type { UserInfo } from '../../../shared/types';
import { relativeTime } from './format';

/** Mesmo mínimo do servidor (server/users/http.ts). */
export const MIN_PASSWORD = 8;

/** Letra do avatar: a primeira do nome, maiúscula; "?" quando vazio. */
export function initialOf(displayName: string): string {
  const first = Array.from(displayName.trim())[0];
  return first ? first.toLocaleUpperCase() : '?';
}

/** Problema da senha nova (curta ou diferente da confirmação), ou `undefined` quando serve. */
export function passwordProblem(password: string, confirm: string): string | undefined {
  if (password.length < MIN_PASSWORD) return tr('A senha precisa ter pelo menos {0} caracteres.', [MIN_PASSWORD]);
  if (password !== confirm) return tr('As senhas não são iguais.');
  return undefined;
}

/** Texto de uma linha da lista de usuários: nome, detalhe "usuario · último acesso …" e se é a própria pessoa. */
export function userRowLabel(u: UserInfo, now: number, meId: number): { name: string; detail: string; isMe: boolean } {
  const isMe = u.id === meId;
  const when = isMe ? tr('agora') : u.lastLoginAt ? relativeTime(u.lastLoginAt, now) : tr('nunca');
  return { name: u.displayName, detail: tr('{0} · último acesso {1}', [u.username, when]), isMe };
}
