import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDoc } from './docs';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'doc-'));
  const project = join(root, 'proj');
  mkdirSync(join(project, 'docs'), { recursive: true });
  writeFileSync(join(project, 'docs', 'a.md'), '# oi');
  writeFileSync(join(project, 'docs', 'a.sql'), 'select 1');
  const acc = join(root, 'acc');
  mkdirSync(join(acc, 'projects', project.replace(/[^a-zA-Z0-9]/g, '-')), { recursive: true });
  return { project, acc };
}

describe('resolveDoc', () => {
  it('abre markdown relativo ao projeto', () => {
    const { project, acc } = setup();
    const r = resolveDoc(project, 'docs/a.md', { accountDirs: [acc] });
    expect('path' in r && r.path.endsWith('/docs/a.md')).toBe(true);
  });

  it('recusa o que não é markdown, escapa da pasta ou não existe', () => {
    const { project, acc } = setup();
    expect('error' in resolveDoc(project, 'docs/a.sql', { accountDirs: [acc] })).toBe(true);
    expect('error' in resolveDoc(project, '../../etc/passwd.md', { accountDirs: [acc] })).toBe(true);
    expect('error' in resolveDoc(project, 'docs/nao.md', { accountDirs: [acc] })).toBe(true);
  });

  it('pasta temporária vale mesmo sem conta que a conheça (a regra das pastas de projeto está em files.test)', () => {
    const { project } = setup();
    expect('path' in resolveDoc(project, 'docs/a.md', { accountDirs: [] })).toBe(true);
  });

  it('só texto (Docker): confere o nome sem tocar o disco', () => {
    expect('path' in resolveDoc('/srv/x', 'docs/a.md', { accountDirs: [], textOnly: true })).toBe(true);
    expect('error' in resolveDoc('/srv/x', 'docs/a.sql', { accountDirs: [], textOnly: true })).toBe(true);
  });

  it('recusa segredo mesmo sendo .md', () => {
    const { project, acc } = setup();
    expect('error' in resolveDoc(project, '.ssh/notas.md', { accountDirs: [acc] })).toBe(true);
  });
});
