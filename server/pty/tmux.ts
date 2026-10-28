// Terminais interativos dentro do tmux. Sem ele, cada `claude` aberto pelo escritório é filho do servidor do
// Habblaud: reiniciar o servidor (um deploy, um crash) fecha o pseudo-terminal e mata todas as conversas abertas.
// Com ele, o `claude` roda numa sessão do tmux (num servidor próprio, `-L habblaud`, sem ler o ~/.tmux.conf) e o
// Habblaud só ANEXA um cliente a essa sessão: quando o servidor cai, o cliente cai e a sessão continua; ao subir,
// o Habblaud reconhece as sessões e anexa de novo (PtyManager.adopt). Quem encerra a conversa de verdade é o
// "Encerrar" (kill-session) ou o próprio Claude Code saindo.
//
// Tudo é síncrono (execFileSync): são consultas de milissegundos e o gerenciador abre terminais de forma síncrona.
// Node puro e sem dependências. O servidor do tmux herda o ambiente de quem o iniciou: o `claude` roda por `env`
// (limpa as variáveis de sessão herdadas e escolhe a conta), não pelo ambiente do servidor.
import { execFileSync } from 'node:child_process';

/** Nome do servidor do tmux (socket): isolado das sessões do próprio usuário. */
export const TMUX_SOCKET = 'habblaud';
/** Prefixo das sessões criadas pelo Habblaud (as outras do mesmo socket são ignoradas). */
export const SESSION_PREFIX = 'habblaud-';

export interface TmuxSession {
  name: string;
  /** PID do processo do painel: o próprio `claude` (rodado por `exec`), o mesmo do registro de sessões. */
  panePid: number;
  /** JSON guardado na criação (pasta, conta, tamanho...). */
  meta: string;
}

export interface TmuxCreate {
  name: string;
  cwd: string;
  cols: number;
  rows: number;
  /** Comando e argumentos, sem shell. */
  argv: string[];
  meta: string;
}

export interface TmuxDriver {
  /** Cria a sessão destacada e devolve o PID do painel. Lança se o tmux recusar ou o comando sair na hora. */
  create(o: TmuxCreate): number;
  /** Sessões do Habblaud que existem agora (vazio se o servidor do tmux não está de pé). */
  list(): TmuxSession[];
  /** Comando que anexa um cliente à sessão (para o node-pty abrir). */
  attach(name: string): { file: string; args: string[] };
  /** Encerra a sessão (e o `claude` dentro dela). Não lança se ela já não existe. */
  kill(name: string): void;
  /** A tela visível da sessão, com os atributos (cores, dim) como escapes; vazio se a sessão não existe. */
  capture(name: string): string;
}

export interface TmuxOptions {
  /** Rolar o histórico com a roda do mouse (o tmux captura o mouse; para selecionar texto, Shift+arrastar). */
  mouse?: boolean;
  socket?: string;
  /** Roda o tmux (testes). Padrão: execFileSync. */
  run?: (args: string[]) => string;
}

/**
 * Opções globais do servidor do tmux. O Claude Code usa Ctrl+B e Esc: o tmux não pode capturar o prefixo nem
 * atrasar o Esc. As que a versão não conhece são ignoradas (cada uma roda sozinha).
 */
function serverOptions(mouse: boolean): string[][] {
  return [
    ['prefix', 'None'],
    ['prefix2', 'None'],
    ['status', 'off'],
    ['escape-time', '0'],
    ['history-limit', '50000'],
    ['mouse', mouse ? 'on' : 'off'],
    ['window-size', 'latest'],
    ['focus-events', 'on'],
    ['extended-keys', 'on'],
    ['allow-passthrough', 'on'],
  ];
}

export function createTmuxDriver(bin: string, opts: TmuxOptions = {}): TmuxDriver {
  const socket = opts.socket ?? TMUX_SOCKET;
  const base = ['-L', socket, '-f', '/dev/null'];
  const run = opts.run ?? ((args: string[]) => execFileSync(bin, [...base, ...args], { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'] }));
  const mouse = opts.mouse ?? true;

  const configure = (name: string, meta: string) => {
    for (const [k, v] of serverOptions(mouse)) {
      try {
        run(['set-option', '-g', k, v]);
      } catch {
        // opção desconhecida nesta versão do tmux
      }
    }
    try {
      run(['set-option', '-ga', 'terminal-features', ',xterm*:RGB']);
    } catch {
      // tmux antigo
    }
    // O `:` no fim faz o alvo valer como sessão para opções ("=nome" sozinho não resolve).
    run(['set-option', '-t', `=${name}:`, '@hb_meta', meta]);
  };

  return {
    create(o) {
      const out = run(['new-session', '-d', '-P', '-F', '#{pane_pid}', '-s', o.name, '-x', String(o.cols), '-y', String(o.rows), '-c', o.cwd, ...o.argv]);
      const pid = Number(out.trim());
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`tmux: pid inesperado (${out.trim()})`);
      try {
        configure(o.name, o.meta);
      } catch (err) {
        // O comando pode ter saído na hora (o tmux fecha a sessão): quem chamou mostra o erro.
        throw new Error(`tmux: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
      }
      return pid;
    },
    list() {
      let out: string;
      try {
        out = run(['list-sessions', '-F', '#{session_name}\t#{pane_pid}\t#{@hb_meta}']);
      } catch {
        return [];
      }
      const sessions: TmuxSession[] = [];
      for (const line of out.split('\n')) {
        const [name, pid, ...meta] = line.split('\t');
        const panePid = Number(pid);
        if (!name?.startsWith(SESSION_PREFIX) || !Number.isSafeInteger(panePid) || panePid <= 0) continue;
        sessions.push({ name, panePid, meta: meta.join('\t') });
      }
      return sessions;
    },
    attach: (name) => ({ file: bin, args: [...base, 'attach-session', '-t', `=${name}`] }),
    capture(name) {
      try {
        return run(['capture-pane', '-p', '-e', '-t', `=${name}:`]);
      } catch {
        return '';
      }
    },
    kill(name) {
      try {
        run(['kill-session', '-t', `=${name}`]);
      } catch {
        // já não existe
      }
    },
  };
}
