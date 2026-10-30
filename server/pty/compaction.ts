// Detecta, na saída do terminal do Claude Code, que a conversa está sendo compactada ("Compacting conversation… (42s ·
// ↓ 3.6k tokens)"). Nada é gravado no transcript durante a compactação, então a tela é a única pista de que o agente não
// está só "pensando". O Claude Code redesenha só o que mudou (o contador), então a frase pode passar uma vez só pelo fluxo
// e continuar na tela: quando há tmux, a tela dele é a fonte da verdade (`screen`); sem ele, vale a frase redesenhada, e sem
// vê-la por TTL_MS a compactação acabou.
const PHRASE = /Compacting\s*conversation/;
/** Na tela vale a linha com o contador, para um texto que apenas cita a frase (uma conversa sobre isso) não valer. */
const LIVE_LINE = /Compacting\s*conversation…?\s*\([^)\n]*\d+s/;
const PHRASE_LENGTH = 'Compacting conversation'.length;
/** Sequências de escape (cores, cursor, títulos) que podem cair no meio do texto. */
// eslint-disable-next-line no-control-regex
const ESCAPES = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]/g;

export const COMPACTION_TTL_MS = 5_000;
/** Com tela para consultar: intervalo mínimo entre duas consultas enquanto não se viu a frase. */
export const COMPACTION_PROBE_MS = 2_000;

/** Devolve a tela visível do terminal (com ou sem escapes); undefined se não dá para consultar. */
export type ScreenProbe = () => string | undefined;

export class CompactionWatch {
  private tail = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private probedAt = 0;
  active = false;

  constructor(
    private readonly onChange: (active: boolean) => void,
    private readonly ttlMs: number = COMPACTION_TTL_MS,
    private readonly screen?: ScreenProbe,
  ) {}

  feed(raw: string): void {
    const text = this.tail + raw.replace(ESCAPES, '');
    // sobra só o que pode ser o começo da frase (uma frase inteira já vista não conta duas vezes)
    this.tail = text.slice(-(PHRASE_LENGTH - 1));
    if (PHRASE.test(text)) {
      this.arm();
      return;
    }
    // O fluxo não repetiu a frase: se há tela, confere nela (de tempos em tempos) em vez de achar que acabou.
    if (!this.active && this.screen) {
      const now = Date.now();
      if (now - this.probedAt < COMPACTION_PROBE_MS) return;
      this.probedAt = now;
      if (this.onScreen()) this.arm();
    }
  }

  private onScreen(): boolean {
    try {
      const s = this.screen?.();
      return !!s && LIVE_LINE.test(s.replace(ESCAPES, ''));
    } catch {
      return false;
    }
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.expire(), this.ttlMs);
    this.timer.unref?.();
    if (!this.active) {
      this.active = true;
      this.onChange(true);
    }
  }

  /** Prazo vencido: com tela, a frase ainda estar nela renova; sem ela, a compactação acabou. */
  private expire(): void {
    this.timer = null;
    if (this.screen && this.onScreen()) return this.arm();
    this.stop();
  }

  private stop(): void {
    if (!this.active) return;
    this.active = false;
    this.onChange(false);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.active = false;
  }
}
