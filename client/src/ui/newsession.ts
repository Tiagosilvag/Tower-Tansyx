// "Nova sessão" na gaveta da sala: com mais de uma conta do Claude Code, deixa escolher em qual abrir o Claude Code novo
// (dois agentes na mesma sala, em contas diferentes). A escolha é pura (aqui, testável); o menu fica em ui/drawer.ts.
import type { AccountInfo, AgentInfo } from '../../../shared/types';

export interface NewSessionChoice {
  account: AccountInfo;
  /** Já há um agente desta conta na sala. */
  inRoom: boolean;
}

/** Contas do Claude Code em que dá abrir uma sessão (o Codex não abre pelo terminal interativo). */
export function claudeAccounts(accounts: readonly AccountInfo[]): AccountInfo[] {
  return accounts.filter((a) => a.provider !== 'codex');
}

/** As contas para escolher, na ordem em que o escritório as lista, com as que já estão na sala marcadas. */
export function newSessionChoices(accounts: readonly AccountInfo[], roomAgents: readonly Pick<AgentInfo, 'account' | 'provider' | 'kind'>[]): NewSessionChoice[] {
  const present = new Set(roomAgents.filter((a) => a.kind === 'main' && a.provider !== 'codex').map((a) => a.account));
  return claudeAccounts(accounts).map((account) => ({ account, inRoom: present.has(account.id) }));
}
