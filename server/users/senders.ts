// Quem mandou cada mensagem do chat (modo de usuários). A marca vive só aqui e na tela: o texto que o agente recebe
// nunca leva o nome. O servidor guarda (hora, texto normalizado, usuário) quando a mensagem sai da página e, ao montar
// a conversa do transcript, procura a marca da mesma mensagem.
import type { Db } from '../db/db';
import type { TerminalEntry } from '../../shared/types';

/** Janela em que o transcript pode registrar a mensagem depois de enviada (fila do agente ocupado). */
const AFTER_SEND_MS = 15 * 60_000;
/** Folga para relógios e ordem dos eventos. */
const BEFORE_SEND_MS = 5_000;
const KEEP_MS = 30 * 24 * 3_600_000;
const KEY_MAX = 2000;
/** Abaixo disto, só texto idêntico vale (evita "ok" marcar qualquer coisa que o contenha). */
const CONTAINS_MIN = 12;

export function senderKey(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, KEY_MAX);
}

interface Row {
  text_key: string;
  display_name: string;
  color: string;
}

export class SenderLog {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    this.prune();
  }

  record(userId: number, text: string, at: number = this.now()): void {
    const key = senderKey(text);
    if (!key) return;
    this.db.run('INSERT INTO message_senders (at, text_key, user_id) VALUES (?, ?, ?)', at, key, userId);
  }

  /** A marca da mensagem registrada em `at` no transcript, se foi mandada pela página por alguém. */
  find(text: string, at: number): { name: string; color: string } | undefined {
    const key = senderKey(text);
    if (!key) return undefined;
    const rows = this.db.all<Row>(
      `SELECT s.text_key, u.display_name, u.color FROM message_senders s JOIN users u ON u.id = s.user_id
       WHERE s.at BETWEEN ? AND ? ORDER BY s.at DESC LIMIT 200`,
      at - AFTER_SEND_MS,
      at + BEFORE_SEND_MS,
    );
    const hit = rows.find((r) => r.text_key === key) ?? rows.find((r) => r.text_key.length >= CONTAINS_MIN && key.includes(r.text_key));
    return hit ? { name: hit.display_name, color: hit.color } : undefined;
  }

  annotate(e: TerminalEntry): TerminalEntry {
    if (e.kind !== 'user') return e;
    try {
      const by = this.find(e.text, e.at);
      return by ? { ...e, by } : e;
    } catch {
      return e;
    }
  }

  private prune(): void {
    this.db.run('DELETE FROM message_senders WHERE at < ?', this.now() - KEEP_MS);
  }
}
