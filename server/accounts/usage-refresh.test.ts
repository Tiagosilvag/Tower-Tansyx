import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiHandler } from '../http/app';
import { createRequestGuard } from '../http/guard';
import { Hub } from '../http/sse';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { tempDir } from '../test/fixtures';
import { request } from '../test/permission-server';
import { AccountsService } from './service';
import { UsageRefresher, type RefreshAccount, type RunOutput, type Runner } from './usage-refresh';

setQuiet(true);

const OK: RunOutput = { code: 0, stdout: 'Current session: 31% used · resets Oct 27, 11:39pm\nCurrent week (all models): 54% used', stderr: '' };

const ACCOUNTS: RefreshAccount[] = [
  { id: '.claude', name: 'Conta C', dir: '/root/.claude', isDefault: true },
  { id: '.claude-socio', name: 'Conta A', dir: '/root/.claude-socio', isDefault: false },
];

function make(run: Runner, over: { accounts?: RefreshAccount[]; env?: NodeJS.ProcessEnv; minIntervalMs?: number; now?: () => number } = {}) {
  const reload = vi.fn();
  const refresher = new UsageRefresher({ bin: '/usr/bin/claude', accounts: () => over.accounts ?? ACCOUNTS, reload, env: over.env ?? {}, cwd: '/tmp', minIntervalMs: over.minIntervalMs ?? 0, run, now: over.now });
  return { refresher, reload };
}

describe('UsageRefresher', () => {
  it('roda `claude -p /usage` em cada conta, sem sessão, e relê o cache uma vez no fim', async () => {
    const calls: { args: string[]; env: NodeJS.ProcessEnv; cwd: string }[] = [];
    const { refresher, reload } = make(async (_bin, args, o) => {
      calls.push({ args, env: o.env, cwd: o.cwd });
      return OK;
    });
    const results = await refresher.run();
    expect(results).toEqual([
      { account: '.claude', name: 'Conta C', ok: true },
      { account: '.claude-socio', name: 'Conta A', ok: true },
    ]);
    expect(calls.map((c) => c.args)).toEqual([
      ['-p', '/usage', '--no-session-persistence'],
      ['-p', '/usage', '--no-session-persistence'],
    ]);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('a conta padrão não leva CLAUDE_CONFIG_DIR; as outras levam; variáveis de sessão herdadas somem', async () => {
    const envs: NodeJS.ProcessEnv[] = [];
    const { refresher } = make(
      async (_b, _a, o) => {
        envs.push(o.env);
        return OK;
      },
      { env: { PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_CONFIG_DIR: '/herdado' } },
    );
    await refresher.run();
    expect(envs[0].CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(envs[1].CLAUDE_CONFIG_DIR).toBe('/root/.claude-socio');
    for (const e of envs) {
      expect(e.PATH).toBe('/bin');
      expect(e.CLAUDECODE).toBeUndefined();
      expect(e.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    }
  });

  it('uma conta falha e a outra não: cada uma com o seu motivo', async () => {
    const { refresher } = make(async (_b, _a, o) =>
      o.env.CLAUDE_CONFIG_DIR ? { code: 0, stdout: '\n /usage is only available for subscription plans.\nmais', stderr: '' } : OK,
    );
    expect(await refresher.run()).toEqual([
      { account: '.claude', name: 'Conta C', ok: true },
      { account: '.claude-socio', name: 'Conta A', ok: false, error: '/usage is only available for subscription plans.' },
    ]);
  });

  it('prazo estourado, código de saída e erro ao rodar viram falhas', async () => {
    const seq: RunOutput[] = [
      { code: null, stdout: '', stderr: '', timedOut: true },
      { code: 3, stdout: '', stderr: 'boom\nresto', },
    ];
    let i = 0;
    const { refresher } = make(async () => seq[i++]);
    const [a, b] = await refresher.run();
    expect(a).toMatchObject({ ok: false, error: 'o Claude Code não respondeu a tempo' });
    expect(b).toMatchObject({ ok: false, error: 'boom' });
    const thrower = make(async () => {
      throw new Error('spawn ENOENT');
    }).refresher;
    expect((await thrower.run())[0]).toMatchObject({ ok: false, error: 'spawn ENOENT' });
  });

  it('pedidos durante uma rodada recebem a mesma rodada (não roda duas vezes)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((ok) => (release = ok));
    const run = vi.fn(async () => {
      await gate;
      return OK;
    });
    const { refresher } = make(run, { accounts: [ACCOUNTS[0]] });
    const a = refresher.run();
    const b = refresher.run();
    expect(refresher.busy).toBe(true);
    release();
    expect(await a).toEqual(await b);
    expect(run).toHaveBeenCalledTimes(1);
    expect(refresher.busy).toBe(false);
  });

  it('um pedido logo depois da rodada recebe o resultado dela; passado o intervalo, roda de novo', async () => {
    let now = 1_000;
    const run = vi.fn(async () => OK);
    const { refresher } = make(run, { accounts: [ACCOUNTS[0]], minIntervalMs: 3_000, now: () => now });
    await refresher.run();
    now += 1_000;
    await refresher.run();
    expect(run).toHaveBeenCalledTimes(1);
    now += 3_000;
    await refresher.run();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('sem contas do Claude Code: resultado vazio', async () => {
    expect(await make(async () => OK, { accounts: [] }).refresher.run()).toEqual([]);
  });
});

describe('POST /api/usage/refresh (rotas de verdade)', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function serve(refresher: UsageRefresher | undefined) {
    const tmp = tempDir();
    const office = new Office({ names: new NameStore(null), version: 't', startedAt: Date.now(), accounts: () => [], sources: () => [], accountName: () => undefined, terminal: true });
    const hub = new Hub(office, { throttleMs: 10 });
    const accounts = new AccountsService({ dirs: [], home: tmp.dir, env: {}, onChange: () => {} });
    const api = createApiHandler({ office, hub, accounts, sources: () => [], version: 't', inDocker: false, terminal: true, usageRefresh: refresher });
    const guard = createRequestGuard({ allowedHosts: new Set(['habblaud.lan']) });
    const server = http.createServer((req, res) => {
      if (guard(req, res)) return;
      if (!api(req, res, new URL(req.url ?? '/', 'http://x'))) res.writeHead(404).end();
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    close = () =>
      new Promise((ok) => {
        hub.stop();
        server.closeAllConnections();
        server.close(() => {
          tmp.cleanup();
          ok();
        });
      });
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('roda e devolve o resultado por conta; /api/access diz que dá para atualizar', async () => {
    const { refresher } = make(async () => OK, { accounts: [ACCOUNTS[0]] });
    const base = await serve(refresher);
    const r = await request(base, '/api/usage/refresh', { method: 'POST', body: {} });
    expect(r).toMatchObject({ status: 200, json: { results: [{ account: '.claude', ok: true }] } });
    expect((await request(base, '/api/access')).json).toMatchObject({ usageRefresh: true });
  });

  it('desligado: 403, e o acesso diz que não; GET é 405; Host que não é local é 403', async () => {
    const base = await serve(undefined);
    expect((await request(base, '/api/usage/refresh', { method: 'POST', body: {} })).status).toBe(403);
    expect((await request(base, '/api/access')).json).toMatchObject({ usageRefresh: false });
    const { refresher } = make(async () => OK);
    await close?.();
    const on = await serve(refresher);
    expect((await request(on, '/api/usage/refresh')).status).toBe(405);
    const remote = await request(on, '/api/usage/refresh', { method: 'POST', body: {}, headers: { Host: 'habblaud.lan' } });
    expect(remote.status).toBe(403);
  });
});
