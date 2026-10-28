import { describe, expect, it } from 'vitest';
import { chosenLabels, parseAskAnswers, parseAskInput } from './termask';

describe('pergunta do agente no chat', () => {
  it('lê as perguntas e as opções (com e sem descrição)', () => {
    const qs = parseAskInput('Como seguimos?\n  - Instalar deps (Recomendado): via apt\n  - Rodar no Windows\n\nOutra?\n  - Sim');
    expect(qs).toEqual([
      { question: 'Como seguimos?', options: [{ label: 'Instalar deps (Recomendado)', desc: 'via apt' }, { label: 'Rodar no Windows' }] },
      { question: 'Outra?', options: [{ label: 'Sim' }] },
    ]);
    expect(parseAskInput(undefined)).toEqual([]);
    expect(parseAskInput('  ')).toEqual([]);
  });

  it('pergunta de várias linhas fica inteira e sem opções também vale', () => {
    expect(parseAskInput('Linha 1\nLinha 2\n  - A')[0].question).toBe('Linha 1\nLinha 2');
    expect(parseAskInput('Só a pergunta')).toEqual([{ question: 'Só a pergunta', options: [] }]);
  });

  it('lê a resposta de cada pergunta e tira o aviso do Claude Code', () => {
    const a = parseAskAnswers('The user answered: "Como seguimos?"="Pode instalar tudo". Read the answers carefully — they may request changes.');
    expect(a.byQuestion.get('Como seguimos?')).toBe('Pode instalar tudo');
    expect(a.text).toBe('"Como seguimos?"="Pode instalar tudo"');
    const b = parseAskAnswers('The user answered: "P1?"="A", "P2?"="B, C". Read the answers carefully');
    expect([...b.byQuestion]).toEqual([['P1?', 'A'], ['P2?', 'B, C']]);
  });

  it('várias perguntas: o texto "Your questions have been answered" também é lido, as duas respostas', () => {
    const a = parseAskAnswers('Your questions have been answered: "Quem atualiza?"="Os dois", "Como definir?"="Nova ação por perfil (Recommended)". You can now continue with these answers in mind.');
    expect([...a.byQuestion]).toEqual([['Quem atualiza?', 'Os dois'], ['Como definir?', 'Nova ação por perfil (Recommended)']]);
    expect(chosenLabels(a.byQuestion.get('Como definir?') ?? '', [{ label: 'Nova ação por perfil (Recommended)' }, { label: 'Fixo' }]).has('Nova ação por perfil (Recommended)')).toBe(true);
  });

  it('aspas dentro da resposta não quebram; formato desconhecido devolve só o texto', () => {
    const a = parseAskAnswers('The user answered: "P?"="ele disse "oi" e saiu". Read the answers carefully');
    expect(a.byQuestion.get('P?')).toBe('ele disse "oi" e saiu');
    const d = parseAskAnswers('User declined to answer');
    expect(d.byQuestion.size).toBe(0);
    expect(d.text).toBe('User declined to answer');
  });

  it('marca as opções escolhidas (uma, várias; texto livre não casa)', () => {
    const opts = [{ label: 'A' }, { label: 'B' }, { label: 'C, D' }];
    expect([...chosenLabels('B', opts)]).toEqual(['B']);
    expect([...chosenLabels('A, B', opts)]).toEqual(['A', 'B']);
    expect([...chosenLabels('C, D', opts)]).toEqual(['C, D']);
    expect([...chosenLabels('outra coisa', opts)]).toEqual([]);
  });
});
