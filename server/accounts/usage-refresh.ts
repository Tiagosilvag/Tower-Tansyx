// Atualizar o uso das contas sob demanda (o botão da barra de uso). O Habblaud não lê credenciais nem fala com a rede:
// o uso chega do statusline (só enquanto uma sessão roda) e do cache do `/usage`. Para uma conta sem sessão aberta
// os números envelhecem, então aqui quem busca é o próprio Claude Code: `claude -p /usage` consulta o plano, mostra o
// uso e grava `cachedUsageUtilization` no .claude.json da conta (sem sessão, sem gastar tokens, ~2 s), e o
// AccountsService.refresh() relê esse cache.
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { tr } from '../../shared/i18n';
import { SESSION_ENV_VARS } from '../claude-bin';
import { errMsg } from '../log';

/** Quanto tempo o PID continua ignorado depois de o processo começar (o comando leva segundos; folga para a saída). */
const OWN_PID_KEEP_MS = 60_000;

export interface RefreshAccount {
  id: string;
  name?: string;
  /** Pasta de configuração (vira CLAUDE_CONFIG_DIR, exceto a conta padrão). */
  dir: string;
  isDefault: boolean;
}

export interface RefreshResult {
  account: string;
  name?: string;
  ok: boolean;
  error?: string;
}

export interface RunOutput {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export type Runner = (bin: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; onPid?: (pid: number) => void }) => Promise<RunOutput>;

export interface UsageRefresherOptions {
  bin: string;
  /** Contas do Claude Code (o Codex não tem como buscar o uso daqui). */
  accounts: () => RefreshAccount[];
  /** Relê o cache de uso das contas (AccountsService.refresh). */
  reload: () => void;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
  /** Intervalo mínimo entre duas rodadas: um novo pedido dentro dele recebe o resultado da última. */
  minIntervalMs?: number;
  run?: Runner;
  now?: () => number;
}

const defaultRun: Runner = (bin, args, o) =>
  new Promise((ok) => {
    const child = execFile(bin, args, { cwd: o.cwd, env: o.env, timeout: o.timeoutMs, maxBuffer: 256 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
      ok({
        code: e ? (typeof e.code === 'number' ? e.code : null) : 0,
        stdout: String(stdout),
        stderr: String(stderr || (e && typeof e.code !== 'number' ? e.message : '')),
        timedOut: !!e?.killed,
      });
    });
    if (child.pid) o.onPid?.(child.pid);
  });

/** Primeira linha com texto, cortada (a mensagem do Claude Code quando não há uso a mostrar). */
function firstLine(s: string): string {
  const line = s.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

export class UsageRefresher {
  private running: Promise<RefreshResult[]> | null = null;
  private last: { at: number; results: RefreshResult[] } | null = null;
  private readonly run_: Runner;
  /** PIDs dos `claude -p /usage` em andamento (e os últimos segundos): não são sessões de ninguém. */
  private readonly own = new Set<number>();
  private readonly now: () => number;

  constructor(private readonly opts: UsageRefresherOptions) {
    this.run_ = opts.run ?? defaultRun;
    this.now = opts.now ?? Date.now;
  }

  /**
   * O processo foi aberto por esta atualização? Cada `claude -p` grava um registro de sessão enquanto roda e o
   * Habblaud o mostraria como um agente (um personagem aparecendo e sumindo na sala da pasta de trabalho).
   */
  owns(pid: number): boolean {
    return this.own.has(pid);
  }

  get busy(): boolean {
    return this.running !== null;
  }

  /** Atualiza todas as contas do Claude Code, em paralelo. Pedidos durante uma rodada recebem o mesmo resultado. */
  run(): Promise<RefreshResult[]> {
    if (this.running) return this.running;
    const min = this.opts.minIntervalMs ?? 3_000;
    if (this.last && this.now() - this.last.at < min) return Promise.resolve(this.last.results);
    const p = this.refreshAll().finally(() => {
      this.running = null;
    });
    this.running = p;
    return p;
  }

  private async refreshAll(): Promise<RefreshResult[]> {
    const accounts = this.opts.accounts();
    const results = await Promise.all(accounts.map((a) => this.refreshOne(a)));
    // Relê o cache de uma vez, depois que todas gravaram.
    try {
      this.opts.reload();
    } catch {
      // o próximo ciclo do servidor relê
    }
    this.last = { at: this.now(), results };
    return results;
  }

  private async refreshOne(a: RefreshAccount): Promise<RefreshResult> {
    const base = { account: a.id, ...(a.name ? { name: a.name } : {}) };
    const env: NodeJS.ProcessEnv = { ...(this.opts.env ?? process.env) };
    for (const k of SESSION_ENV_VARS) delete env[k];
    if (a.isDefault) delete env.CLAUDE_CONFIG_DIR;
    else env.CLAUDE_CONFIG_DIR = a.dir;
    let out: RunOutput;
    try {
      out = await this.run_(this.opts.bin, ['-p', '/usage', '--no-session-persistence'], {
        cwd: this.opts.cwd ?? homedir(),
        env,
        timeoutMs: this.opts.timeoutMs ?? 45_000,
        onPid: (pid) => {
          this.own.add(pid);
          // O registro some quando o processo sai; um pouco de folga cobre a leitura que já estava em andamento.
          setTimeout(() => this.own.delete(pid), OWN_PID_KEEP_MS).unref?.();
        },
      });
    } catch (err) {
      return { ...base, ok: false, error: errMsg(err) };
    }
    if (out.timedOut) return { ...base, ok: false, error: tr('o Claude Code não respondeu a tempo') };
    // O `/usage` mostra "Current session: N% used"; sem isso (conta com chave de API, sem plano) vem só um aviso.
    if (out.code === 0 && /\d+\s*%/.test(out.stdout)) return { ...base, ok: true };
    return { ...base, ok: false, error: firstLine(out.stdout) || firstLine(out.stderr) || tr('o Claude Code saiu com o código {0}', [out.code ?? '?']) };
  }
}
