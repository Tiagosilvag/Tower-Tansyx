// Projeto novo pelo "Novo agente": cria a pasta (e o `git init`) para quem quer começar uma aplicação do zero, em vez de
// escolher uma pasta que já existe. A pasta fica dentro de um diretório de projetos (HABBLAUD_PROJECTS_DIR; senão
// ~/projetos, se existir, ou ~/projects) e o nome é só um nome simples: nada de caminhos, então ninguém cria pastas
// fora dali. O repositório no GitHub NÃO é criado aqui: o agente propõe e você aprova no chat. Node puro.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { tr } from '../../shared/i18n';

export const PROJECT_NAME_MAX = 64;

/** Letras, números, `.`, `_` e `-`, começando por letra ou número (nada de `/`, `..` sozinho, espaços ou `.git`). */
const NAME_OK = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class ProjectError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ProjectInfo {
  name: string;
  /** Caminho absoluto da pasta criada. */
  path: string;
  /** O `git init` rodou. */
  git: boolean;
  /** O que o usuário precisa saber (ex.: o git não está instalado). */
  note?: string;
}

/** Por que o nome não serve (undefined = serve). */
export function projectNameProblem(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return tr('dê um nome ao projeto');
  const name = raw.trim();
  if (name.length > PROJECT_NAME_MAX) return tr('o nome do projeto tem no máximo {0} caracteres', [PROJECT_NAME_MAX]);
  if (!NAME_OK.test(name)) return tr('use só letras, números, ponto, hífen e sublinhado no nome (sem espaços nem barras)');
  if (name.endsWith('.') || name.toLowerCase().endsWith('.git')) return tr('o nome do projeto não pode terminar em ponto nem em .git');
  return undefined;
}

/** O diretório onde os projetos novos nascem. */
export function projectsDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir(), exists: (p: string) => boolean = existsSync): string {
  const set = env.HABBLAUD_PROJECTS_DIR?.trim();
  if (set) return set;
  const pt = join(home, 'projetos');
  return exists(pt) ? pt : join(home, 'projects');
}

/** `git init` na pasta; false se o git não existe ou recusa. Tenta `-b main` e, em git antigo, o padrão. */
export type GitInit = (cwd: string) => Promise<boolean>;

const run = (args: string[], cwd: string): Promise<boolean> =>
  new Promise((ok) => {
    execFile('git', args, { cwd, timeout: 10_000, windowsHide: true }, (err) => ok(!err));
  });

export const gitInit: GitInit = async (cwd) => (await run(['init', '-b', 'main'], cwd)) || (await run(['init'], cwd));

export interface ProjectCreator {
  /** Onde o projeto novo seria criado (para a tela mostrar o caminho). */
  dir(): string;
  create(name: unknown): Promise<ProjectInfo>;
}

export function createProjectCreator(opts: { dir?: () => string; git?: GitInit } = {}): ProjectCreator {
  const dir = opts.dir ?? (() => projectsDir());
  const git = opts.git ?? gitInit;
  return {
    dir,
    async create(raw) {
      const problem = projectNameProblem(raw);
      if (problem) throw new ProjectError(400, problem);
      const name = String(raw).trim();
      const base = dir();
      const path = join(base, name);
      try {
        mkdirSync(base, { recursive: true });
        mkdirSync(path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new ProjectError(409, tr('já existe uma pasta chamada {0} em {1}', [name, base]));
        throw new ProjectError(500, tr('não consegui criar a pasta {0}: {1}', [path, (err as Error).message]));
      }
      const ok = await git(path).catch(() => false);
      return { name, path, git: ok, ...(ok ? {} : { note: tr('a pasta foi criada, mas o git não rodou (ele está instalado?): rode `git init` nela depois') }) };
    },
  };
}
