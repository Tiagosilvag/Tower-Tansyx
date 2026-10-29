import { describe, expect, it } from 'vitest';
import { choiceOf, compactTokens, contextPercent, contextWindow, modelLabel, PAUSE_KEYS, switchModelKeys } from './session-info';

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
