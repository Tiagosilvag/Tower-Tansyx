// A sugestão de próximo prompt do Claude Code (o texto cinza no campo de entrada, que o Tab aceita). Ela não vai para o
// transcript nem para o registro de sessões: só existe na tela do terminal. Para uma sessão que roda no tmux do
// Habblaud dá para lê-la de lá: `tmux capture-pane -e` traz a tela com os atributos, e a sugestão é o texto em "dim"
// (SGR 2) depois do `❯` da última linha de entrada; o que a pessoa digita não vem em dim.
// Depende de como o Claude Code desenha o prompt (um `❯`, depois o texto fraco): se mudar, simplesmente não acha nada.

const ESC = '\x1b';
/** Tira os atributos (cores, negrito...) de uma linha da tela. */
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
/** "Liga o dim" (parâmetro 2 sozinho entre os do SGR). */
const DIM_ON = new RegExp(`${ESC}\\[(?:\\d+;)*2(?:;\\d+)*m`);
/** Qualquer atributo que não seja o dim: o texto fraco termina nele. */
const ANY_SGR = new RegExp(`${ESC}\\[[0-9;]*m`);
/** O primeiro caractere do prompt do Claude Code. */
const PROMPT = '❯';
const NBSP = ' ';

/** O dim que começa em `line` até o próximo atributo (ou o fim da linha). */
function dimText(line: string): string | undefined {
  const m = DIM_ON.exec(line);
  if (!m) return undefined;
  const rest = line.slice(m.index + m[0].length);
  const end = rest.search(ANY_SGR);
  const text = (end === -1 ? rest : rest.slice(0, end)).replace(new RegExp(NBSP, 'g'), ' ').trim();
  return text || undefined;
}

/** Linha de moldura (a régua `────` em cima e embaixo do campo de entrada). */
function isRule(plain: string): boolean {
  const t = plain.trim();
  return t.length >= 8 && /^[─━—-]+$/.test(t);
}

/**
 * A sugestão de prompt que a tela `screen` (saída do `tmux capture-pane -p -e`) mostra no campo de entrada, ou undefined
 * se não há (campo vazio sem sugestão, a pessoa digitando, o Claude trabalhando).
 */
export function parsePromptSuggestion(screen: string): string | undefined {
  const lines = screen.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const plain = lines[i].replace(SGR, '').trimEnd();
    // A última linha com `❯` da tela é o campo de entrada (as de cima são prompts antigos na conversa).
    if (!plain.startsWith(PROMPT)) continue;
    const first = dimText(lines[i]);
    if (!first) return undefined;
    // Sugestão comprida quebra na linha de baixo (também em dim, sem texto normal), até a régua de baixo.
    const parts = [first];
    for (let j = i + 1; j < lines.length; j++) {
      const p = lines[j].replace(SGR, '').trim();
      if (!p || isRule(p)) break;
      const more = dimText(lines[j]);
      if (!more || more !== p.replace(new RegExp(NBSP, 'g'), ' ')) break;
      parts.push(more);
    }
    const text = parts.join(' ').replace(/\s+/g, ' ').trim();
    // A dica de exemplo do campo vazio de uma sessão nova (`Try "..."`) não é uma sugestão da conversa.
    if (!text || /^Try ["“']/.test(text)) return undefined;
    return text;
  }
  return undefined;
}
