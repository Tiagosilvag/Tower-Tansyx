import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PtyError, type PtyManager } from '../pty/manager';
import { createPtyRoutes } from './pty';

describe('POST /api/pty/:id/attach', () => {
  let server: Server;
  let dir: string;
  let base: string;
  const prevDir = process.env.HABBLAUD_ATTACHMENTS_DIR;

  beforeEach(async () => {
    dir = mkdtempSync(`${tmpdir()}/habblaud-attach-`);
    process.env.HABBLAUD_ATTACHMENTS_DIR = dir;
    const ptys = {
      assertRunning: (id: string) => {
        if (id !== 'ok') throw new PtyError(404, 'terminal não encontrado');
      },
    } as unknown as PtyManager;
    const route = createPtyRoutes(ptys);
    server = createServer((req, res) => route(req, res, new URL(req.url ?? '/', 'http://x').pathname));
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise((ok) => server.close(ok));
    rmSync(dir, { recursive: true, force: true });
    if (prevDir === undefined) delete process.env.HABBLAUD_ATTACHMENTS_DIR;
    else process.env.HABBLAUD_ATTACHMENTS_DIR = prevDir;
  });

  const post = (id: string, body: unknown) =>
    fetch(`${base}/api/pty/${id}/attach`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('grava o arquivo e devolve o caminho', async () => {
    const res = await post('ok', { name: '../../foto.png', type: 'image/png', data: Buffer.from('png!').toString('base64') });
    expect(res.status).toBe(201);
    const j = (await res.json()) as { path: string; name: string };
    expect(j.name).toBe('foto.png');
    expect(j.path.startsWith(dir)).toBe(true);
    expect(readFileSync(j.path, 'utf8')).toBe('png!');
  });

  it('recusa terminal desconhecido e arquivo vazio', async () => {
    expect((await post('nao', { name: 'a', data: 'AAAA' })).status).toBe(404);
    expect((await post('ok', { name: 'a', data: '' })).status).toBe(400);
  });
});
