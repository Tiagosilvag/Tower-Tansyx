// A pergunta do agente (AskUserQuestion) e a resposta que você deu, para o chat desenhar um cartão em vez do bloco
// bruto de ferramenta. O servidor manda a pergunta como texto ("pergunta\n  - opção: descrição") e o resultado no
// formato do Claude Code ("The user answered: "pergunta"="resposta". Read the answers carefully…"). Funções puras,
// testadas em ui/termask.test.ts; quem desenha é ui/terminal.ts.

export interface AskOption {
  label: string;
  desc?: string;
}

export interface AskQuestion {
  question: string;
  options: AskOption[];
}

/** As perguntas (e as opções de cada uma) do texto de entrada da ferramenta. */
export function parseAskInput(text: string | undefined): AskQuestion[] {
  if (!text?.trim()) return [];
  const out: AskQuestion[] = [];
  for (const block of text.split(/\n\n+/)) {
    const question: string[] = [];
    const options: AskOption[] = [];
    for (const line of block.split('\n')) {
      const opt = /^\s+- (.*)$/.exec(line);
      if (!opt) {
        // Antes da primeira opção, as linhas são a pergunta (que pode ter mais de uma).
        if (!options.length) question.push(line);
        continue;
      }
      const i = opt[1].indexOf(': ');
      options.push(i > 0 ? { label: opt[1].slice(0, i), desc: opt[1].slice(i + 2) } : { label: opt[1] });
    }
    const q = question.join('\n').trim();
    if (q) out.push({ question: q, options });
  }
  return out;
}

export interface AskAnswers {
  /** Resposta de cada pergunta, pelo texto dela. */
  byQuestion: Map<string, string>;
  /** O resultado sem o prefixo e o aviso do Claude Code, para quando ele não segue o formato "pergunta"="resposta". */
  text: string;
}

/**
 * Lê o resultado. O Claude Code usa mais de um texto em volta dos pares: uma pergunta vem como
 * `The user answered: "pergunta"="resposta". Read the answers carefully…` e várias como
 * `Your questions have been answered: "p1"="r1", "p2"="r2". You can now continue with these answers in mind.`
 * Então o prefixo é tudo antes da primeira aspa e o aviso final é cortado pelas frases que conhecemos.
 */
export function parseAskAnswers(result: string): AskAnswers {
  const text = result
    .replace(/\s*(Read the answers carefully|You can now continue)[\s\S]*$/, '')
    .replace(/^[^"]*(?=")/, '')
    .replace(/\.\s*$/, '')
    .trim();
  const byQuestion = new Map<string, string>();
  // Pares "pergunta"="resposta" separados por vírgula; aspas dentro da resposta não quebram (o par termina em `", "`).
  const pair = /"([\s\S]*?)"="([\s\S]*?)"(?=\s*,\s*"|\s*$)/g;
  for (let m = pair.exec(text); m; m = pair.exec(text)) byQuestion.set(m[1], m[2]);
  return { byQuestion, text };
}

/** Quais opções foram escolhidas (a resposta de múltipla escolha vem como "A, B"); texto livre ("Outro") não casa com nenhuma. */
export function chosenLabels(answer: string, options: readonly AskOption[]): Set<string> {
  const parts = answer.split(/\s*,\s*/).map((p) => p.trim());
  const chosen = new Set<string>();
  for (const o of options) {
    if (answer.trim() === o.label || parts.includes(o.label)) chosen.add(o.label);
  }
  return chosen;
}
