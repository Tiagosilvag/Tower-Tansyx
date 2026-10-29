// Detecta, na saída do terminal do Claude Code, que a conversa está sendo compactada ("Compacting conversation… (42s ·
// ↓ 3.6k tokens)"). Nada é gravado no transcript durante a compactação, então a tela é a única pista de que o agente não
// está só "pensando". A linha é redesenhada a cada segundo; sem vê-la por TTL_MS, a compactação acabou.
const PHRASE = /Compacting conversation/;
const PHRASE_LENGTH = 'Compacting conversation'.length;
/** Sequências de escape (cores, cursor, títulos) que podem cair no meio do texto. */
// eslint-disable-next-line no-control-regex
const ESCAPES = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]/g;

export const COMPACTION_TTL_MS = 5_000;

export class CompactionWatch {
  private tail = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  active = false;

  constructor(
    private readonly onChange: (active: boolean) => void,
    private readonly ttlMs: number = COMPACTION_TTL_MS,
  ) {}

  feed(raw: string): void {
    const text = this.tail + raw.replace(ESCAPES, '');
    // sobra só o que pode ser o começo da frase (uma frase inteira já vista não conta duas vezes)
    this.tail = text.slice(-(PHRASE_LENGTH - 1));
    if (!PHRASE.test(text)) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.stop(), this.ttlMs);
    this.timer.unref?.();
    if (!this.active) {
      this.active = true;
      this.onChange(true);
    }
  }

  private stop(): void {
    this.timer = null;
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
