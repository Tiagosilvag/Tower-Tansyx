import { describe, expect, it } from 'vitest';
import { openDb } from '../db/db';
import { SenderLog } from './senders';
import { UserStore } from './store';
import { TypedLines } from './typing';
import { hashPassword } from '../remote/password';

const HASH = await hashPassword('senha-da-ana-1', 10);

function montar(agora = 1_000_000) {
  const db = openDb(':memory:');
  const users = new UserStore(db);
  const ana = users.create({ username: 'ana', displayName: 'Ana', color: '#fac665', passwordHash: HASH });
  const clock = { now: agora };
  return { db, users, ana, clock, log: new SenderLog(db, () => clock.now) };
}

describe('SenderLog', () => {
  it('marca o prompt do transcript com o nome e a cor de quem mandou', () => {
    const { log, ana } = montar();
    log.record(ana.id, 'Foque mais na geração do HTML', 1_000_000);
    expect(log.find('Foque mais na geração do HTML', 1_003_000)).toEqual({ name: 'Ana', color: '#fac665' });
  });

  it('ignora espaços e quebras de linha na comparação', () => {
    const { log, ana } = montar();
    log.record(ana.id, 'um  texto\ncom quebra', 1_000_000);
    expect(log.find('um texto com quebra', 1_001_000)?.name).toBe('Ana');
  });

  it('prompt que ninguém mandou pela página fica sem marca', () => {
    const { log, ana } = montar();
    log.record(ana.id, 'outra coisa', 1_000_000);
    expect(log.find('Foque mais no HTML', 1_001_000)).toBeUndefined();
  });

  it('fora da janela de tempo não marca', () => {
    const { log, ana } = montar();
    log.record(ana.id, 'mensagem antiga', 1_000_000);
    expect(log.find('mensagem antiga', 1_000_000 + 16 * 60_000)).toBeUndefined();
  });

  it('texto curto só casa se for idêntico; um longo pode vir embrulhado no transcript', () => {
    const { log, ana } = montar();
    log.record(ana.id, 'ok', 1_000_000);
    expect(log.find('ok vamos em frente', 1_001_000)).toBeUndefined();
    log.record(ana.id, 'aplique a validação no modo Power BI', 1_000_000);
    expect(log.find('[mensagem do escritório] aplique a validação no modo Power BI', 1_001_000)?.name).toBe('Ana');
  });

  it('removido o usuário, a marca some', () => {
    const { log, ana, users } = montar();
    users.create({ username: 'bia', passwordHash: HASH });
    log.record(ana.id, 'texto de quem saiu', 1_000_000);
    users.remove(ana.id);
    expect(log.find('texto de quem saiu', 1_001_000)).toBeUndefined();
  });

  it('annotate só mexe em prompt e põe `by`; as outras entradas passam intactas', () => {
    const { log, ana } = montar();
    log.record(ana.id, 'olá agente', 1_000_000);
    const u = log.annotate({ kind: 'user', id: 'a', at: 1_001_000, text: 'olá agente' });
    expect(u).toMatchObject({ by: { name: 'Ana', color: '#fac665' } });
    const a = { kind: 'assistant' as const, id: 'b', at: 1_001_000, text: 'olá agente' };
    expect(log.annotate(a)).toBe(a);
  });

  it('apaga marcas de mais de 30 dias ao abrir', () => {
    const { db, ana, clock } = montar();
    const velho = new SenderLog(db, () => clock.now);
    velho.record(ana.id, 'muito antigo', clock.now);
    clock.now += 31 * 24 * 3_600_000;
    new SenderLog(db, () => clock.now);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM message_senders')?.n).toBe(0);
  });
});

describe('TypedLines', () => {
  it('devolve a linha digitada no Enter', () => {
    const t = new TypedLines();
    expect(t.feed('1:p', 'ola')).toEqual([]);
    expect(t.feed('1:p', ' mundo\r')).toEqual(['ola mundo']);
  });

  it('backspace e Ctrl-C editam; Enter vazio não envia', () => {
    const t = new TypedLines();
    expect(t.feed('1:p', 'abx\x7fc\r')).toEqual(['abc']);
    expect(t.feed('1:p', 'lixo\x03\r')).toEqual([]);
  });

  it('texto colado (bracketed paste) com quebras vira uma só linha enviada', () => {
    const t = new TypedLines();
    expect(t.feed('1:p', '\x1b[200~linha 1\rlinha 2\x1b[201~\r')).toEqual(['linha 1\nlinha 2']);
  });

  it('ignora setas e teclas de função', () => {
    const t = new TypedLines();
    expect(t.feed('1:p', 'a\x1b[Ab\x1bOPc\r')).toEqual(['abc']);
  });

  it('cada usuário e terminal tem o próprio buffer', () => {
    const t = new TypedLines();
    t.feed('1:p', 'um');
    expect(t.feed('2:p', 'dois\r')).toEqual(['dois']);
    expect(t.feed('1:p', '\r')).toEqual(['um']);
  });
});
