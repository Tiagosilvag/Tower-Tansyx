import { describe, expect, it } from 'vitest';
import { parsePromptSuggestion } from './suggestion';

const RULE = '\x1b[38;5;244m' + '─'.repeat(40) + '\x1b[39m';
const NB = ' ';

/** Tela mínima: conversa, régua, campo de entrada, régua, rodapé. */
const screen = (inputLine: string, extra: string[] = []) =>
  ['  \x1b[38;5;246m✻\x1b[39m Churned for 26s · done 10:55 PM', RULE, inputLine, ...extra, RULE, '  \x1b[38;5;220m⏵⏵ auto mode on\x1b[38;5;246m (shift+tab to cycle)\x1b[39m'].join('\n');

describe('parsePromptSuggestion', () => {
  it('lê o texto em dim depois do ❯ (a tela de verdade: ❯, espaço sem quebra, dim, reset)', () => {
    expect(parsePromptSuggestion(screen(`\x1b[39m❯${NB}\x1b[2mVou dar git pull no checkout principal\x1b[0m`))).toBe('Vou dar git pull no checkout principal');
  });

  it('campo vazio, a pessoa digitando ou o Claude trabalhando: sem sugestão', () => {
    expect(parsePromptSuggestion(screen(`\x1b[39m❯${NB}`))).toBeUndefined();
    expect(parsePromptSuggestion(screen(`\x1b[38;5;246m❯${NB}\x1b[39m`))).toBeUndefined();
    expect(parsePromptSuggestion(screen(`\x1b[39m❯${NB}atualiza o resumo`))).toBeUndefined();
  });

  it('só vale a última linha com ❯ (prompts antigos da conversa ficam de fora)', () => {
    const old = `\x1b[2m❯${NB}Pode fazer o restart\x1b[0m`;
    const s = [old, 'resposta', RULE, `\x1b[39m❯${NB}`, RULE].join('\n');
    expect(parsePromptSuggestion(s)).toBeUndefined();
  });

  it('aceita o dim junto de outros atributos e termina no próximo atributo', () => {
    expect(parsePromptSuggestion(screen(`❯${NB}\x1b[2;3mfaça o deploy\x1b[0m`))).toBe('faça o deploy');
    expect(parsePromptSuggestion(screen(`❯${NB}\x1b[38;5;246m\x1b[2mfaça o deploy\x1b[22m resto normal`))).toBe('faça o deploy');
  });

  it('sugestão comprida que quebra na linha de baixo é juntada', () => {
    const s = screen(`❯${NB}\x1b[2mAtualiza o RESUMO-DO-TRABALHO.md com tudo`, [`  \x1b[2mque foi feito hoje\x1b[0m`]);
    expect(parsePromptSuggestion(s)).toBe('Atualiza o RESUMO-DO-TRABALHO.md com tudo que foi feito hoje');
  });

  it('a dica de exemplo do campo vazio (Try "...") não é sugestão; tela sem prompt também não', () => {
    expect(parsePromptSuggestion(screen(`❯${NB}\x1b[2mTry "fix the failing tests"\x1b[0m`))).toBeUndefined();
    expect(parsePromptSuggestion('só texto\nsem prompt')).toBeUndefined();
    expect(parsePromptSuggestion('')).toBeUndefined();
  });
});
