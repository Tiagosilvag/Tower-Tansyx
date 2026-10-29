// Quem fez cada requisição da porta remota no modo de usuários: o portão anota, a API consulta. WeakMap para a anotação
// sumir junto com a requisição, sem cabeçalho que um cliente possa forjar.
import type { IncomingMessage } from 'node:http';
import type { User } from './store';

const users = new WeakMap<IncomingMessage, User>();

export function setUser(req: IncomingMessage, user: User): void {
  users.set(req, user);
}

export function userOf(req: IncomingMessage): User | undefined {
  return users.get(req);
}
