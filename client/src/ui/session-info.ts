// Informações da sessão no chat (modelo, contexto) e o que é digitado no terminal para pausar e trocar de modelo.
// Puro (testado em session-info.test.ts).

import { tr } from '../../../shared/i18n';

/** Modelos oferecidos na troca (o `/model` do Claude Code aceita o nome completo). */
export const MODEL_CHOICES: readonly { id: string; label: string; hint: string }[] = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', hint: tr('equilibrado') },
  { id: 'claude-fable-5-1', label: 'Fable 5.1', hint: tr('mais capaz') },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', hint: tr('rápido') },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', hint: tr('mais rápido') },
];

const CONTEXT_STD = 200_000;
const CONTEXT_1M = 1_000_000;

/** "claude-opus-5-5" → "Opus 5.5"; nome que não segue o padrão aparece como veio (sem o prefixo "claude-"). */
export function modelLabel(id: string | undefined): string {
  if (!id) return '';
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?=$|-|\[)/.exec(id);
  if (!m) return id.replace(/^claude-/, '');
  const family = m[1][0].toUpperCase() + m[1].slice(1);
  return `${family} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}

/** O modelo da lista de troca que corresponde a `id` (compara pelo começo: ignora data e sufixos). */
export function choiceOf(id: string | undefined): (typeof MODEL_CHOICES)[number] | undefined {
  return id ? MODEL_CHOICES.find((c) => id === c.id || id.startsWith(`${c.id}-`) || id.startsWith(`${c.id}[`)) : undefined;
}

/**
 * Janela de contexto estimada: 1 milhão se o nome diz "1m" ou se já há mais de 200 mil tokens (não caberia na
 * padrão); senão, 200 mil.
 */
export function contextWindow(model: string | undefined, tokens: number): number {
  return /\[1m\]|-1m\b/i.test(model ?? '') || tokens > CONTEXT_STD ? CONTEXT_1M : CONTEXT_STD;
}

/** Porcentagem (0 a 100) da janela, ou undefined sem medida. */
export function contextPercent(model: string | undefined, tokens: number | undefined): number | undefined {
  if (!tokens || tokens <= 0) return undefined;
  return Math.min(100, Math.round((tokens / contextWindow(model, tokens)) * 100));
}

/** 124310 → "124 mil", 3_200_000 → "3,2 mi"; abaixo de mil, o número. */
export function compactTokens(n: number, locale?: string): string {
  const f = (v: number, d: number) => v.toLocaleString(locale, { maximumFractionDigits: d });
  if (n >= 1_000_000) return `${f(n / 1_000_000, 1)} mi`;
  if (n >= 1_000) return `${f(n / 1_000, 0)} mil`;
  return f(n, 0);
}

/** Esc: o Claude Code interrompe o que está fazendo e espera o próximo prompt. */
export const PAUSE_KEYS = '\x1b';

/**
 * Apagar a última mensagem: o seletor de voltar a conversa do Claude Code (Esc Esc, a mensagem anterior, "Restaurar
 * conversa") e, no fim, limpar o texto que volta para a caixa. Cada passo é uma tecla e quanto esperar depois dela.
 */
export const DELETE_LAST_STEPS: ReadonlyArray<readonly [keys: string, waitMs: number]> = [
  ['\x15', 200],
  ['\x1b', 400],
  ['\x1b', 900],
  ['\x1b[A', 500],
  ['\r', 900],
  ['\r', 900],
  ['\x15', 0],
];

/** Comando que compacta a conversa do Claude Code (o Enter vai depois, em outro envio). */
export const COMPACT_COMMAND = '/compact';

export const RENAME_MAX = 90;

/** Nome novo da sessão pronto para o /rename: uma linha só, sem teclas de controle; vazio vira null. */
export function renameName(raw: string): string | null {
  // eslint-disable-next-line no-control-regex
  const name = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, RENAME_MAX);
  return name || null;
}

/** Limpa o que estiver digitado na linha (Ctrl+U) e digita o /rename; o Enter vai depois, em outro envio. */
export function renameKeys(name: string): string {
  return `\x15/rename ${name}`;
}

/** Troca o modelo: limpa o que estiver digitado na linha (Ctrl+U) e manda o /model. */
export function switchModelKeys(modelId: string): string {
  return `\x15/model ${modelId}\r`;
}
