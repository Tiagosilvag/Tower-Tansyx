// npm run users:add | users:passwd | users:list — as contas do modo de usuários (HABBLAUD_REMOTE_USERS=1).
//
// Mexe direto no banco do servidor (HABBLAUD_DB ou <dataDir>/habblaud.db, o mesmo caminho do server/config.ts): é
// assim que nasce o primeiro usuário, antes de existir alguém para entrar e cadastrar os outros pela API. A validação
// (nome, cor, tamanho da senha) é a mesma da API, e o hash é o scrypt de custo padrão.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDb } from '../server/db/db';
import { loadConfig } from '../server/config';
import { hashPassword } from '../server/remote/password';
import { COLOR_RE, MAX_DISPLAY_NAME, MIN_PASSWORD } from '../server/users/http';
import { usernameProblem, UserError, UserStore } from '../server/users/store';
import { tr } from '../shared/i18n';
import { askHidden, readStdinLine } from './remote-setup';

export interface UsersIo {
  store: UserStore;
  /** Lê uma senha (escondida no terminal, ou a linha do --password-stdin). */
  readPassword(prompt: string): Promise<string>;
  out(line: string): void;
  /** Só os testes trocam (custo menor); o padrão é o scrypt de custo normal. */
  hash?: (password: string) => Promise<string>;
}

const USAGE = tr(`Uso:
  npm run users:add -- <usuario> [--name "Nome"] [--color #rrggbb] [--password-stdin]
  npm run users:passwd -- <usuario> [--password-stdin]
  npm run users:list`);

/** Erro de uso: a mensagem já traduzida vira a saída e o código 1. */
class Refused extends Error {}

interface Args {
  command?: string;
  username?: string;
  name?: string;
  color?: string;
  passwordStdin: boolean;
}

function parse(argv: string[]): Args {
  const out: Args = { passwordStdin: false };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Refused(tr('falta o valor de {0}', [a]));
      return v;
    };
    if (a === '--name') out.name = val();
    else if (a === '--color') out.color = val();
    else if (a === '--password-stdin') out.passwordStdin = true;
    else if (a.startsWith('--')) throw new Refused(tr('opção desconhecida: {0}', [a]));
    else rest.push(a);
  }
  [out.command, out.username] = rest;
  if (rest.length > 2) throw new Refused(tr('argumento a mais: {0}', [rest[2]]));
  return out;
}

/** A senha nova: duas vezes no terminal, uma com --password-stdin; o mínimo é o mesmo da API. */
async function newPassword(io: UsersIo, args: Args): Promise<string> {
  const password = await io.readPassword(tr('Senha ({0}+ caracteres; não aparece enquanto você digita)', [MIN_PASSWORD]));
  if (password.length < MIN_PASSWORD) throw new Refused(tr('senha recusada: {0}', [tr('use pelo menos {0} caracteres', [MIN_PASSWORD])]));
  if (!args.passwordStdin && (await io.readPassword(tr('Repita a senha'))) !== password) throw new Refused(tr('as duas senhas não batem'));
  return password;
}

function needUser(args: Args): string {
  if (args.username === undefined) throw new Refused(USAGE);
  const problem = usernameProblem(args.username);
  if (problem) throw new Refused(problem);
  return args.username.trim().toLowerCase();
}

export async function runUsers(argv: string[], io: UsersIo): Promise<number> {
  const hash = io.hash ?? ((p: string) => hashPassword(p));
  const { store } = io;
  try {
    const args = parse(argv);
    if (args.command === 'list') {
      const users = store.list();
      if (!users.length) io.out(tr('Nenhum usuário. Crie o primeiro com npm run users:add -- <usuario>'));
      for (const u of users) io.out(`${u.username}  ${u.displayName}`);
      return 0;
    }
    if (args.command === 'add') {
      const username = needUser(args);
      let displayName: string | undefined;
      if (args.name !== undefined) {
        displayName = args.name.trim();
        if (displayName.length < 1 || displayName.length > MAX_DISPLAY_NAME) {
          throw new Refused(tr('o nome de exibição deve ter de 1 a {0} caracteres', [MAX_DISPLAY_NAME]));
        }
      }
      if (args.color !== undefined && !COLOR_RE.test(args.color)) throw new Refused(tr('a cor deve estar no formato #rrggbb'));
      // antes de perguntar a senha: não faz digitar duas vezes à toa
      if (store.record(username)) throw new Refused(tr('já existe um usuário com esse nome'));
      const passwordHash = await hash(await newPassword(io, args));
      store.create({ username, displayName, color: args.color, passwordHash });
      io.out(tr('Usuário {0} criado.', [username]));
      // o servidor só sobe a porta remota se houver usuário na hora em que liga
      if (store.count() === 1) io.out(tr('É o primeiro usuário: reinicie o Habblaud para ligar o acesso remoto.'));
      return 0;
    }
    if (args.command === 'passwd') {
      const username = needUser(args);
      const record = store.record(username);
      if (!record) throw new Refused(tr('usuário não encontrado'));
      store.setPasswordHash(record.id, await hash(await newPassword(io, args)));
      io.out(tr('Senha de {0} trocada; as sessões abertas dele foram encerradas.', [username]));
      return 0;
    }
    io.out(USAGE);
    return 1;
  } catch (err) {
    if (err instanceof Refused || err instanceof UserError) {
      io.out(err.message);
      return 1;
    }
    throw err;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  const db = openDb(loadConfig(process.env, []).dbFile);
  const fromStdin = argv.includes('--password-stdin');
  let line: Promise<string> | undefined;
  runUsers(argv, {
    store: new UserStore(db),
    readPassword: (prompt) => (fromStdin ? (line ??= readStdinLine()) : askHidden(prompt)),
    out: (l) => console.log(l),
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error(tr('[users] Erro: {0}', [(err as Error).message]));
      process.exitCode = 1;
    })
    .finally(() => db.close());
}
