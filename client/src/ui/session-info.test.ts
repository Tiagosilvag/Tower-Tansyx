import { describe, expect, it } from 'vitest';
import { DELETE_LAST_STEPS, choiceOf, compactTokens, contextPercent, contextWindow, modelLabel, PAUSE_KEYS, renameKeys, renameName, switchModelKeys } from './session-info';

describe('renomear a sessão', () => {
  it('limpa quebras de linha e teclas de controle e limita o tamanho', () => {
    expect(renameName('  Meu\nprojeto\x1b[A  novo ')).toBe('Meu projeto [A novo');
    expect(renameName('a'.repeat(200))).toHaveLength(90);
  });
  it('nome vazio não renomeia', () => {
    expect(renameName('  \n\t ')).toBeNull();
  });
  it('digita o /rename depois de limpar a linha', () => {
    expect(renameKeys('Nome')).toBe('\x15/rename Nome');
  });
});

describe('modelLabel', () => {
  it('formata os nomes do padrão claude-<família>-<maior>-<menor>', () => {
    expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelLabel('claude-fable-5-1')).toBe('Fable 5.1');
    expect(modelLabel('claude-haiku-5-5-20260101')).toBe('Haiku 5.5');
    expect(modelLabel('claude-sonnet-5')).toBe('Sonnet 5');
    expect(modelLabel('claude-opus-5-5[1m]')).toBe('Opus 5.5');
  });
  it('nome fora do padrão aparece como veio; vazio some', () => {
    expect(modelLabel('gpt-9')).toBe('gpt-9');
    expect(modelLabel(undefined)).toBe('');
  });
});

describe('choiceOf', () => {
  it('acha o modelo da lista ignorando data e sufixo', () => {
    expect(choiceOf('claude-opus-5-5')?.label).toBe('Opus 5.5');
    expect(choiceOf('claude-sonnet-5-5-20260101')?.label).toBe('Sonnet 5.5');
    expect(choiceOf('claude-opus-5-50')).toBeUndefined();
    expect(choiceOf(undefined)).toBeUndefined();
  });
});

describe('contexto', () => {
  it('janela: 200 mil, ou 1 milhão se o nome diz 1m ou se passou de 200 mil', () => {
    expect(contextWindow('claude-opus-5-5', 50_000)).toBe(200_000);
    expect(contextWindow('claude-opus-5-5[1m]', 50_000)).toBe(1_000_000);
    expect(contextWindow('claude-opus-5-5', 350_000)).toBe(1_000_000);
  });
  it('porcentagem arredondada; sem medida não inventa', () => {
    expect(contextPercent('claude-opus-5-5', 124_000)).toBe(62);
    expect(contextPercent('claude-opus-5-5', 0)).toBeUndefined();
    expect(contextPercent('claude-opus-5-5', undefined)).toBeUndefined();
  });
  it('números compactos', () => {
    expect(compactTokens(124_310, 'pt-BR')).toBe('124 mil');
    expect(compactTokens(3_200_000, 'pt-BR')).toBe('3,2 mi');
    expect(compactTokens(950, 'pt-BR')).toBe('950');
  });
});

describe('teclas', () => {
  it('pausar é Esc; trocar de modelo limpa a linha e manda /model com Enter', () => {
    expect(PAUSE_KEYS).toBe('\x1b');
    expect(switchModelKeys('claude-opus-5-5')).toBe('\x15/model claude-opus-5-5\r');
  });
});

describe('apagar a última mensagem', () => {
  it('abre o seletor com Esc Esc, escolhe a última mensagem, confirma e limpa a caixa', () => {
    expect(DELETE_LAST_STEPS.map(([k]) => k)).toEqual(['\x15', '\x1b', '\x1b', '\x1b[A', '\r', '\r', '\x15']);
  });
});
