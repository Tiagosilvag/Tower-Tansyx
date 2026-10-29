// A subida do servidor de verdade no modo de usuários: sem ninguém cadastrado, ou sem conseguir abrir o banco, a porta
// remota NÃO pode subir (nunca degrada para uma porta sem login). Processo real, ambiente mínimo: nada do shell
// (HABBLAUD_PTY, contas, pastas de produção) vaza para dentro.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from './db/db';
import { hashPassword } from './remote/password';
import { tempDir } from './test/fixtures';
import { UserStore } from './users/store';

// hash de verdade, calculado uma vez no carregamento (top-level await): o setup do boot é síncrono
const HASH = await hashPassword('senha-de-teste-123', 10);

const children: ChildProcess[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (children.length) children.pop()!.kill('SIGKILL');
  while (cleanups.length) cleanups.pop()!();
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

const accepts = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const c = net.connect(port, '127.0.0.1');
    c.once('connect', () => (c.destroy(), resolve(true)));
    c.once('error', () => resolve(false));
  });

/** Sobe `server/index.ts` e espera o log `until` (ou o fim do processo); devolve o log inteiro e as portas. */
async function boot(setup: (dir: string) => { db?: string }, until: RegExp, extraEnv: NodeJS.ProcessEnv = {}) {
  const tmp = tempDir();
  cleanups.push(tmp.cleanup);
  const home = join(tmp.dir, 'home');
  mkdirSync(home);
  const { db } = setup(tmp.dir);
  const port = await freePort();
  const remotePort = await freePort();
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    HABBLAUD_PORT: String(port),
    HABBLAUD_REMOTE_PORT: String(remotePort),
    HABBLAUD_DATA_DIR: join(tmp.dir, 'data'),
    HABBLAUD_CLAUDE_DIRS: join(home, '.claude'),
    HABBLAUD_USAGE_DIR: join(tmp.dir, 'usage'),
    HABBLAUD_LANG: 'pt-BR',
    HABBLAUD_PTY: '', // vazio de propósito: sem terminal interativo, nunca anexa às sessões tmux reais
    HABBLAUD_UPDATE_CHECK: '0',
    HABBLAUD_REMOTE_USERS: '1',
    HABBLAUD_REMOTE_INSECURE_HTTP: '1',
    HABBLAUD_REMOTE_HOST: '127.0.0.1',
    ...(db ? { HABBLAUD_DB: db } : {}),
    ...extraEnv,
  };
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { env, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let log = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`sem "${until}" a tempo; log:\n${log}`)), 20_000);
    const onData = (chunk: Buffer) => {
      log += chunk.toString();
      if (until.test(log)) (clearTimeout(timer), resolve());
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    child.once('exit', () => (clearTimeout(timer), resolve()));
  });
  return { log: () => log, port, remotePort };
}

describe('subida no modo de usuários (processo real)', () => {
  it('sem nenhum usuário, a porta remota não sobe e o aviso manda criar um', async () => {
    const s = await boot(() => ({}), /em http:\/\/127\.0\.0\.1:\d+/);
    expect(s.log()).toMatch(/nenhum usuário; rode npm run users:add/);
    expect(await accepts(s.port)).toBe(true);
    expect(await accepts(s.remotePort)).toBe(false);
  }, 30_000);

  it('banco que não abre: a porta remota não sobe e o log diz por quê', async () => {
    const s = await boot(
      (dir) => {
        // o "banco" fica dentro de um arquivo comum: openDb não consegue criar a pasta nem o arquivo
        const file = join(dir, 'arquivo-comum');
        writeFileSync(file, 'x');
        return { db: join(file, 'habblaud.db') };
      },
      /em http:\/\/127\.0\.0\.1:\d+/,
    );
    expect(s.log()).toMatch(/não deu para abrir o banco de usuários/);
    expect(await accepts(s.port)).toBe(true);
    expect(await accepts(s.remotePort)).toBe(false);
  }, 30_000);

  it('controle: com um usuário cadastrado a mesma subida abre a porta remota', async () => {
    const s = await boot(
      (dir) => {
        const file = join(dir, 'usuarios.db');
        const db = openDb(file);
        new UserStore(db).create({ username: 'tiago', passwordHash: HASH });
        db.close();
        return { db: file };
      },
      /Acesso remoto: ligado/,
    );
    expect(s.log()).toMatch(/Acesso remoto: ligado.*1 cadastrado/);
    expect(await accepts(s.remotePort)).toBe(true);
  }, 30_000);
});

describe('Kanban na subida real', () => {
  it('responde na porta local mesmo sem o modo de usuários, e um agente grava com a marca', async () => {
    const s = await boot(() => ({}), /em http:\/\/127\.0\.0\.1:\d+/, { HABBLAUD_REMOTE_USERS: '' });
    const base = `http://127.0.0.1:${s.port}`;
    const boards = await (await fetch(`${base}/api/kanban/boards`)).json();
    expect(boards.boards).toMatchObject([{ kind: 'general', name: 'Geral' }]);
    const r = await fetch(`${base}/api/kanban/boards/${boards.boards[0].id}/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Habblaud-Via': 'agent' },
      body: JSON.stringify({ title: 'do agente', as: 'ninguem' }),
    });
    expect(r.status).toBe(201);
    const card = (await r.json()).card;
    expect(card).toMatchObject({ title: 'do agente', createdBy: null, createdVia: 'agent' });
    // O guard do servidor exige JSON em todo pedido que não é GET: o DELETE da página manda `{}` e passa; sem isso é 415.
    const del = (headers: Record<string, string>) => fetch(`${base}/api/kanban/cards/${card.id}`, { method: 'DELETE', headers, body: Object.keys(headers).length ? '{}' : undefined });
    expect((await del({})).status).toBe(415);
    expect((await del({ 'Content-Type': 'application/json' })).status).toBe(204);
  }, 30_000);

  it('sem banco (não abre) o Kanban fica desligado: 404 e o servidor segue de pé', async () => {
    const s = await boot(
      (dir) => {
        const file = join(dir, 'arquivo-comum');
        writeFileSync(file, 'x');
        return { db: join(file, 'habblaud.db') };
      },
      /em http:\/\/127\.0\.0\.1:\d+/,
      { HABBLAUD_REMOTE_USERS: '' },
    );
    expect(s.log()).toMatch(/Kanban: desligado/);
    expect((await fetch(`http://127.0.0.1:${s.port}/api/kanban/boards`)).status).toBe(404);
  }, 30_000);

  it('com a porta local exposta na rede (HABBLAUD_HOST=0.0.0.0) o Kanban vira só leitura, com "as" ou sem', async () => {
    const s = await boot(() => ({}), /em http:\/\/localhost:\d+/, { HABBLAUD_REMOTE_USERS: '', HABBLAUD_HOST: '0.0.0.0' });
    const base = `http://127.0.0.1:${s.port}`;
    expect((await fetch(`${base}/api/kanban/boards`)).status).toBe(200);
    const r = await fetch(`${base}/api/kanban/boards/1/cards`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Habblaud-Via': 'agent' }, body: JSON.stringify({ title: 'de fora', as: 'tiago' }) });
    expect(r.status).toBe(403);
  }, 30_000);
});
