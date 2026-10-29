// Chamadas à API do terminal interativo (server/http/pty.ts). Erros viram Error com a mensagem do servidor.
import { isDemoId } from '../../../shared/timeline';
import type { AgentInfo, PtyInfo } from '../../../shared/types';
import { providerOf } from './provider';
import { tr } from '../../../shared/i18n';

/**
 * Dá para encerrar ou assumir este agente pelo escritório? Só o agente principal de uma sessão do Claude Code: o
 * Codex não tem registro de sessões nem `--resume` aqui, e os agentes do demo não existem de verdade.
 */
export function ptyControllable(a: Pick<AgentInfo, 'id' | 'kind' | 'provider'> | null | undefined): boolean {
  return !!a && a.kind === 'main' && providerOf(a) === 'claude' && !isDemoId(a.id);
}

export async function postPty<T = unknown>(url: string, body: unknown): Promise<T | undefined> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  } catch {
    throw new Error(tr('o Habblaud não respondeu'));
  }
  if (res.status === 204) return undefined;
  const j = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(j.error ?? tr('erro {0}', [res.status]));
  return j as T;
}

const SIZE = { cols: 120, rows: 32 };

/**
 * Sessão do Claude Code na pasta (e conta) indicada; com `resume`, retoma a conversa daquela sessão encerrada; com
 * `prompt`, a conversa nova já começa com esse pedido (projeto novo).
 */
export function createPty(cwd: string, account?: string, resume?: string, prompt?: string): Promise<PtyInfo | undefined> {
  return postPty<PtyInfo>('/api/pty', { cwd, account, ...(resume ? { resume } : {}), ...(prompt ? { prompt } : {}), ...SIZE });
}

/** O terminal do Habblaud rodando este agente (só com ele dá para mandar teclas: pausar, trocar de modelo). */
export function ptyOfAgent(store: { snapshot?: { ptys?: PtyInfo[] } | null }, agentId: string): PtyInfo | undefined {
  return store.snapshot?.ptys?.find((p) => p.agentId === agentId && p.exitedAt === undefined);
}

/** Digita no terminal interativo (Esc, /model...). */
export async function sendPtyKeys(ptyId: string, data: string): Promise<void> {
  await postPty(`/api/pty/${encodeURIComponent(ptyId)}/input`, { data });
}

/** Encerra a sessão noutro terminal e continua a mesma conversa aqui. */
export function takeoverAgent(agentId: string): Promise<PtyInfo | undefined> {
  return postPty<PtyInfo>(`/api/agents/${encodeURIComponent(agentId)}/takeover`, SIZE);
}

/** Encerra o agente (aqui ou noutro terminal). */
export async function stopAgent(agentId: string): Promise<void> {
  await postPty(`/api/agents/${encodeURIComponent(agentId)}/stop`, {});
}

export async function closePty(id: string): Promise<void> {
  await postPty(`/api/pty/${encodeURIComponent(id)}/close`, {});
}

function fileToBase64(file: Blob): Promise<string> {
  return new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => fail(new Error(tr('não deu para ler o arquivo')));
    r.readAsDataURL(file);
  });
}

/** Envia um arquivo ao computador (~/.habblaud/attachments) e devolve o caminho onde ficou. */
export function attachToPty(id: string, file: File): Promise<string> {
  return uploadFile(`/api/pty/${encodeURIComponent(id)}/attach`, file);
}

/** O mesmo para a caixa de mensagem (agentes sem terminal interativo). */
export function attachToMessage(file: File): Promise<string> {
  return uploadFile('/api/messages/attachments', file);
}

async function uploadFile(url: string, file: File): Promise<string> {
  const r = await postPty<{ path: string }>(url, {
    name: file.name || 'imagem.png',
    type: file.type,
    data: await fileToBase64(file),
  });
  if (!r?.path) throw new Error(tr('erro {0}', [500]));
  return r.path;
}
