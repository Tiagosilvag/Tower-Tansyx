import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../server/db/db';
import { hashPassword, parsePasswordHash } from '../server/remote/password';
import { UserStore } from '../server/users/store';
import { runUsers } from './users';

// logN 10: o menor custo que parsePasswordHash aceita (o comando de verdade usa o padrão, que seria lento aqui).
const barato = (p: string) => hashPassword(p, 10);

const abertos: Db[] = [];
afterEach(() => {
  while (abertos.length) abertos.pop()!.close();
});

/** Armazém em memória e um terminal falso: as senhas digitadas saem da fila, na ordem. */
function montar(...senhas: string[]) {
  const db = openDb(':memory:');
  abertos.push(db);
  const store = new UserStore(db);
  const linhas: string[] = [];
  const perguntas: string[] = [];
  const io = {
    store,
    hash: barato,
    readPassword: async (q: string) => {
      perguntas.push(q);
      const s = senhas.shift();
      if (s === undefined) throw new Error('senha não esperada');
      return s;
    },
    out: (l: string) => void linhas.push(l),
  };
  const rodar = (...argv: string[]) => runUsers(argv, io);
  return { store, linhas, perguntas, rodar };
}

describe('runUsers', () => {
  it('add cria o usuário (senha perguntada duas vezes) e list mostra nome e exibição, sem hash', async () => {
    const t = montar('senha-do-tiago', 'senha-do-tiago');
    expect(await t.rodar('add', 'tiago', '--name', 'Tiago')).toBe(0);
    expect(t.perguntas).toHaveLength(2);
    const rec = t.store.record('tiago')!;
    expect(rec.displayName).toBe('Tiago');
    expect(parsePasswordHash(rec.passwordHash)).toBeDefined();
    t.linhas.length = 0;
    expect(await t.rodar('list')).toBe(0);
    expect(t.linhas).toContain('tiago  Tiago');
    expect(t.linhas.join('\n')).not.toContain('scrypt:');
  });

  it('add com --color grava a cor; cor fora de #rrggbb é recusada antes de perguntar a senha', async () => {
    const t = montar('senha-do-tiago', 'senha-do-tiago');
    expect(await t.rodar('add', 'tiago', '--color', '#123abc')).toBe(0);
    expect(t.store.record('tiago')!.color).toBe('#123abc');
    expect(await t.rodar('add', 'ana', '--color', 'azul')).not.toBe(0);
    expect(t.store.record('ana')).toBeUndefined();
    expect(t.perguntas).toHaveLength(2);
  });

  it('add repetido, com outra caixa, devolve código diferente de 0 e explica', async () => {
    const t = montar('senha-do-tiago', 'senha-do-tiago');
    expect(await t.rodar('add', 'tiago')).toBe(0);
    t.linhas.length = 0;
    expect(await t.rodar('add', 'TIAGO')).not.toBe(0);
    expect(t.linhas.join('\n')).toMatch(/já existe um usuário com esse nome/);
    expect(t.store.count()).toBe(1);
  });

  it('senha de 7 caracteres é recusada e nada é criado', async () => {
    const t = montar('1234567', '1234567');
    expect(await t.rodar('add', 'tiago')).not.toBe(0);
    expect(t.linhas.join('\n')).toMatch(/use pelo menos 8 caracteres/);
    expect(t.store.count()).toBe(0);
  });

  it('as duas senhas diferentes são recusadas', async () => {
    const t = montar('senha-do-tiago', 'senha-do-tiagx');
    expect(await t.rodar('add', 'tiago')).not.toBe(0);
    expect(t.store.count()).toBe(0);
  });

  it('nome de usuário inválido passa pela mesma validação da API', async () => {
    const t = montar();
    expect(await t.rodar('add', '../x')).not.toBe(0);
    expect(t.linhas.join('\n')).toMatch(/o nome de usuário deve ter de 1 a 32 caracteres/);
    expect(t.perguntas).toHaveLength(0);
  });

  it('--password-stdin pergunta uma vez só', async () => {
    const t = montar('senha-do-tiago');
    expect(await t.rodar('add', 'tiago', '--password-stdin')).toBe(0);
    expect(t.perguntas).toHaveLength(1);
    expect(t.store.count()).toBe(1);
  });

  it('passwd troca o hash', async () => {
    const t = montar('senha-do-tiago', 'senha-do-tiago', 'senha-nova-123', 'senha-nova-123');
    await t.rodar('add', 'tiago');
    const antes = t.store.record('tiago')!.passwordHash;
    expect(await t.rodar('passwd', 'tiago')).toBe(0);
    expect(t.store.record('tiago')!.passwordHash).not.toBe(antes);
  });

  it('passwd de quem não existe devolve código diferente de 0 sem perguntar a senha', async () => {
    const t = montar();
    expect(await t.rodar('passwd', 'fulano')).not.toBe(0);
    expect(t.linhas.join('\n')).toMatch(/usuário não encontrado/);
    expect(t.perguntas).toHaveLength(0);
  });

  it('comando desconhecido ou sem usuário devolve código diferente de 0', async () => {
    const t = montar();
    expect(await t.rodar('apagar', 'tiago')).not.toBe(0);
    expect(await t.rodar('add')).not.toBe(0);
    expect(await t.rodar('add', 'tiago', '--name')).not.toBe(0);
  });
});
