import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProjectCreator, projectNameProblem, ProjectError, projectsDir } from './project';

describe('nome do projeto', () => {
  it('aceita nomes simples e recusa caminhos, espaços e vazios', () => {
    for (const ok of ['meu-app', 'App_2', 'v1.0', 'a']) expect(projectNameProblem(ok)).toBeUndefined();
    for (const bad of ['', '   ', undefined, 42, '../fora', 'a/b', '.oculto', 'meu app', '-x', 'x.git', 'x.', 'a'.repeat(65)]) expect(projectNameProblem(bad)).toBeTruthy();
  });
});

describe('onde os projetos novos nascem', () => {
  it('HABBLAUD_PROJECTS_DIR, senão ~/projetos se existir, senão ~/projects', () => {
    expect(projectsDir({ HABBLAUD_PROJECTS_DIR: ' /srv/apps ' }, '/home/ana', () => false)).toBe('/srv/apps');
    expect(projectsDir({}, '/home/ana', (p) => p === '/home/ana/projetos')).toBe('/home/ana/projetos');
    expect(projectsDir({}, '/home/ana', () => false)).toBe('/home/ana/projects');
  });
});

describe('criar o projeto', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'habblaud-proj-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('cria a pasta (e o diretório de projetos, se faltar) e roda o git init de verdade', async () => {
    const base = join(dir, 'novo-diretorio');
    const c = createProjectCreator({ dir: () => base });
    const info = await c.create('  meu-app ');
    expect(info).toEqual({ name: 'meu-app', path: join(base, 'meu-app'), git: true });
    expect(existsSync(join(base, 'meu-app', '.git'))).toBe(true);
  });

  it('pasta que já existe é 409 e nada é sobrescrito; nome inválido é 400', async () => {
    const c = createProjectCreator({ dir: () => dir, git: async () => true });
    await c.create('app');
    await expect(c.create('app')).rejects.toMatchObject({ status: 409 });
    await expect(c.create('../x')).rejects.toBeInstanceOf(ProjectError);
    await expect(c.create('../x')).rejects.toMatchObject({ status: 400 });
    expect(existsSync(join(dir, '..', 'x'))).toBe(false);
  });

  it('git que falha não impede a pasta: avisa na nota', async () => {
    const c = createProjectCreator({ dir: () => dir, git: async () => false });
    const info = await c.create('semgit');
    expect(info.git).toBe(false);
    expect(info.note).toBeTruthy();
    expect(existsSync(info.path)).toBe(true);
  });
});
