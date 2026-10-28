import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { PtyManager, type PtyProcess } from './manager';
import { createTmuxDriver, SESSION_PREFIX, type TmuxCreate, type TmuxDriver, type TmuxSession } from './tmux';

/** tmux de mentira: guarda as sessões "vivas" (é o que sobrevive ao reinício do servidor). */
class FakeTmux implements TmuxDriver {
  sessions = new Map<string, TmuxSession>();
  killed: string[] = [];
  created: TmuxCreate[] = [];
  private next = 7000;
  create(o: TmuxCreate): number {
    this.created.push(o);
    const panePid = ++this.next;
    this.sessions.set(o.name, { name: o.name, panePid, meta: o.meta });
    return panePid;
  }
  list(): TmuxSession[] {
    return [...this.sessions.values()];
  }
  attach(name: string) {
    return { file: 'tmux', args: ['attach-session', '-t', `=${name}`] };
  }
  kill(name: string): void {
    this.killed.push(name);
    this.sessions.delete(name);
  }
}

class FakeClient implements PtyProcess {
  exit: (e: { exitCode: number }) => void = () => {};
  killed = false;
  constructor(readonly pid: number) {}
  onData() {}
  onExit(cb: (e: { exitCode: number }) => void) {
    this.exit = cb;
  }
  write() {}
  resize() {}
  kill() {
    this.killed = true;
    this.exit({ exitCode: 0 });
  }
}

function manager(tmux: FakeTmux | null, clients: FakeClient[] = [], calls: { file: string; args: string[] }[] = []) {
  let pid = 100;
  return new PtyManager({
    spawn: (file, args) => {
      calls.push({ file, args });
      const c = new FakeClient(++pid);
      clients.push(c);
      return c;
    },
    tmux,
    claudeBin: process.execPath,
    accounts: () => [{ id: 'acc', dir: '/conta', isDefault: true }],
    agent: () => undefined,
    onChange: () => {},
  });
}

describe('PtyManager com tmux', () => {
  it('roda o claude no tmux (por env, sem shell) e só anexa um cliente a ele', () => {
    const tmux = new FakeTmux();
    const calls: { file: string; args: string[] }[] = [];
    const m = manager(tmux, [], calls);
    const info = m.create({ cwd: tmpdir() });
    expect(info.id).toMatch(/^t[0-9a-f]{8}$/);
    const made = tmux.created[0];
    expect(made.name).toBe(SESSION_PREFIX + info.id);
    // O pid do agente é o do painel (o claude), não o do cliente anexado.
    expect(info.pid).toBe(7001);
    expect(info.agentId).toBe('acc:7001');
    expect(made.argv[0]).toBe('env');
    expect(made.argv).toContain('-u');
    expect(made.argv).toContain('CLAUDECODE');
    expect(made.argv.at(-1)).toBe(process.execPath);
    expect(calls).toEqual([{ file: 'tmux', args: ['attach-session', '-t', `=${made.name}`] }]);
  });

  it('conta que não é a padrão vai por CLAUDE_CONFIG_DIR; a padrão tira a variável', () => {
    const tmux = new FakeTmux();
    const m = new PtyManager({
      spawn: () => new FakeClient(1),
      tmux,
      claudeBin: process.execPath,
      accounts: () => [
        { id: 'a', dir: '/conta-a', isDefault: true },
        { id: 'b', dir: '/conta-b', isDefault: false },
      ],
      agent: () => undefined,
      onChange: () => {},
    });
    m.create({ cwd: tmpdir(), account: 'b' });
    m.create({ cwd: tmpdir(), account: 'a' });
    expect(tmux.created[0].argv).toContain('CLAUDE_CONFIG_DIR=/conta-b');
    expect(tmux.created[1].argv.join(' ')).toMatch(/-u CLAUDE_CONFIG_DIR/);
    expect(tmux.created[1].argv.join(' ')).not.toMatch(/CLAUDE_CONFIG_DIR=/);
  });

  it('retomar leva o --resume ao claude e a conta/pasta ao meta', () => {
    const tmux = new FakeTmux();
    const m = new PtyManager({
      spawn: () => new FakeClient(1),
      tmux,
      claudeBin: process.execPath,
      accounts: () => [{ id: 'acc', dir: '/conta', isDefault: true }],
      sessionCwd: () => tmpdir(),
      agent: () => undefined,
      onChange: () => {},
    });
    const sid = '0f8fad5b-d9cb-469f-a165-70867728950e';
    m.create({ cwd: tmpdir(), resume: sid });
    expect(tmux.created[0].argv.slice(-2)).toEqual(['--resume', sid]);
    expect(JSON.parse(tmux.created[0].meta)).toMatchObject({ account: 'acc', cwd: tmpdir(), resumed: sid });
  });

  it('reiniciar o servidor não encerra a sessão: stopAll só derruba o cliente, e adopt volta com o mesmo id', () => {
    const tmux = new FakeTmux();
    const first = manager(tmux);
    const info = first.create({ cwd: tmpdir() });
    first.stopAll();
    expect(tmux.killed).toEqual([]);
    expect(tmux.sessions.size).toBe(1);

    // "Servidor novo": gerenciador novo, mesma tmux.
    const clients: FakeClient[] = [];
    const second = manager(tmux, clients);
    expect(second.adopt()).toBe(1);
    const back = second.list();
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ id: info.id, pid: info.pid, agentId: info.agentId, cwd: tmpdir(), account: 'acc' });
    expect(back[0].exitedAt).toBeUndefined();
    expect(clients).toHaveLength(1);
    // Adotar de novo não duplica.
    expect(second.adopt()).toBe(0);
  });

  it('Encerrar (close) derruba a sessão do tmux de verdade', () => {
    const tmux = new FakeTmux();
    const m = manager(tmux);
    const info = m.create({ cwd: tmpdir() });
    m.close(info.id);
    expect(tmux.killed).toEqual([SESSION_PREFIX + info.id]);
    expect(m.list()[0].exitedAt).toBeDefined();
  });

  it('o Claude saindo (sessão some do tmux) marca o terminal como encerrado', () => {
    const tmux = new FakeTmux();
    const clients: FakeClient[] = [];
    const m = manager(tmux, clients);
    const info = m.create({ cwd: tmpdir() });
    tmux.sessions.clear();
    clients[0].exit({ exitCode: 0 });
    expect(m.list().find((p) => p.id === info.id)?.exitedAt).toBeDefined();
  });

  it('cliente desconectado com a sessão viva é reanexado; um que cai logo ao anexar não vira laço', () => {
    const tmux = new FakeTmux();
    const clients: FakeClient[] = [];
    let now = 1_000_000;
    const m = new PtyManager({
      spawn: () => {
        const c = new FakeClient(clients.length + 1);
        clients.push(c);
        return c;
      },
      tmux,
      claudeBin: process.execPath,
      accounts: () => [{ id: 'acc', dir: '/conta', isDefault: true }],
      agent: () => undefined,
      onChange: () => {},
      now: () => now,
    });
    const info = m.create({ cwd: tmpdir() });
    now += 60_000;
    clients[0].exit({ exitCode: 0 });
    expect(clients).toHaveLength(2);
    expect(m.list().find((p) => p.id === info.id)?.exitedAt).toBeUndefined();
    // O novo cliente cai em seguida (menos de 2 s): encerra em vez de reanexar sem parar.
    now += 500;
    clients[1].exit({ exitCode: 1 });
    expect(clients).toHaveLength(2);
    expect(m.list().find((p) => p.id === info.id)?.exitedAt).toBeDefined();
  });

  it('sem tmux (null), o claude continua sendo filho direto do pty', () => {
    const calls: { file: string; args: string[] }[] = [];
    const m = manager(null, [], calls);
    const info = m.create({ cwd: tmpdir() });
    expect(info.id).toMatch(/^p1-/);
    expect(calls[0].file).toBe(process.execPath);
    expect(m.adopt()).toBe(0);
  });

  it('adopt ignora sessão do tmux sem meta ou de conta desconhecida', () => {
    const tmux = new FakeTmux();
    tmux.sessions.set(`${SESSION_PREFIX}x1`, { name: `${SESSION_PREFIX}x1`, panePid: 9, meta: '' });
    tmux.sessions.set(`${SESSION_PREFIX}x2`, { name: `${SESSION_PREFIX}x2`, panePid: 10, meta: JSON.stringify({ cwd: '/p', account: 'outra' }) });
    expect(manager(tmux).adopt()).toBe(0);
  });
});

describe('driver do tmux (comandos)', () => {
  it('create: new-session sem shell, opções do servidor e o meta; devolve o pid do painel', () => {
    const log: string[][] = [];
    const run = (args: string[]) => {
      log.push(args);
      return args[0] === 'new-session' ? '4321\n' : '';
    };
    const pid = createTmuxDriver('tmux', { run }).create({ name: 'habblaud-t1', cwd: '/p', cols: 100, rows: 30, argv: ['env', 'claude'], meta: '{"a":1}' });
    expect(pid).toBe(4321);
    expect(log[0]).toEqual(['new-session', '-d', '-P', '-F', '#{pane_pid}', '-s', 'habblaud-t1', '-x', '100', '-y', '30', '-c', '/p', 'env', 'claude']);
    const flat = log.map((a) => a.join(' '));
    expect(flat).toContain('set-option -g prefix None');
    expect(flat).toContain('set-option -g escape-time 0');
    expect(flat).toContain('set-option -g mouse on');
    expect(flat).toContain('set-option -t =habblaud-t1: @hb_meta {"a":1}');
  });

  it('opção que a versão do tmux não conhece não impede de criar', () => {
    const run = (args: string[]) => {
      if (args[0] === 'new-session') return '5\n';
      if (args.includes('extended-keys')) throw new Error('unknown option');
      return '';
    };
    expect(createTmuxDriver('tmux', { run }).create({ name: 'habblaud-t2', cwd: '/p', cols: 80, rows: 24, argv: ['x'], meta: '{}' })).toBe(5);
  });

  it('list: só sessões do Habblaud, com pid e meta; sem servidor do tmux = vazio', () => {
    const out = ['habblaud-t1\t11\t{"a":1}', 'minha-sessao\t12\t', 'habblaud-t3\tx\t', ''].join('\n');
    expect(createTmuxDriver('tmux', { run: () => out }).list()).toEqual([{ name: 'habblaud-t1', panePid: 11, meta: '{"a":1}' }]);
    expect(
      createTmuxDriver('tmux', {
        run: () => {
          throw new Error('no server running');
        },
      }).list(),
    ).toEqual([]);
  });

  it('attach usa o socket próprio e o nome exato da sessão', () => {
    const a = createTmuxDriver('/usr/bin/tmux').attach('habblaud-t1');
    expect(a.file).toBe('/usr/bin/tmux');
    expect(a.args).toEqual(['-L', 'habblaud', '-f', '/dev/null', 'attach-session', '-t', '=habblaud-t1']);
  });
});

/** Contra o tmux de verdade, num socket só deste teste (some ao fim). */
const tmuxBin = (() => {
  try {
    return execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim() || undefined;
  } catch {
    return undefined;
  }
})();

describe.skipIf(!tmuxBin || process.platform === 'win32')('driver do tmux (tmux de verdade)', () => {
  it('cria, lista (com pid e meta), sobrevive ao "cliente" e encerra', () => {
    const socket = `habblaud-test-${process.pid}-${Date.now()}`;
    const d = createTmuxDriver(tmuxBin!, { socket });
    try {
      const pid = d.create({ name: `${SESSION_PREFIX}real1`, cwd: tmpdir(), cols: 90, rows: 25, argv: ['env', 'COLORTERM=truecolor', 'sleep', '30'], meta: JSON.stringify({ account: 'acc', cwd: tmpdir(), nota: 'ç ã' }) });
      expect(pid).toBeGreaterThan(0);
      const list = d.list();
      expect(list).toHaveLength(1);
      expect(list[0].panePid).toBe(pid);
      expect(JSON.parse(list[0].meta)).toMatchObject({ account: 'acc', nota: 'ç ã' });
      d.kill(`${SESSION_PREFIX}real1`);
      expect(d.list()).toEqual([]);
      // Encerrar o que não existe não lança.
      d.kill(`${SESSION_PREFIX}real1`);
    } finally {
      try {
        execFileSync(tmuxBin!, ['-L', socket, 'kill-server'], { stdio: 'ignore' });
      } catch {
        // já não havia servidor
      }
    }
  });
});
