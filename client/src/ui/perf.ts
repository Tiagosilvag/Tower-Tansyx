// Desempenho (Configurações › Desempenho): o modo escolhido (automático, normal, leve, mínimo), o que cada nível
// muda e o "automático", que passa do normal para o leve quando o escritório fica lento. Puro (testado em perf.test.ts).

/** O que o usuário escolhe. */
export type PerfMode = 'auto' | 'normal' | 'light' | 'min';
/** O que está valendo (o automático resolve para um destes). */
export type PerfLevel = 'normal' | 'light' | 'min';

export const PERF_MODES: readonly PerfMode[] = ['auto', 'normal', 'light', 'min'];

/** Abaixo disto (quadros por segundo) por AUTO_SECONDS segundos seguidos, o automático liga o modo leve. */
export const AUTO_FPS = 24;
export const AUTO_SECONDS = 10;
/** Linhas do chat mantidas na tela, por nível (o resto sai do DOM; ver TerminalLog.trim). */
export const CHAT_ROWS: Record<PerfLevel, number> = { normal: 1500, light: 1500, min: 150 };
/** Quadros por segundo desenhados, por nível (0 = sem limite, o do navegador). */
export const FPS_CAP: Record<PerfLevel, number> = { normal: 0, light: 30, min: 30 };

export function levelOf(mode: PerfMode, autoLevel: PerfLevel): PerfLevel {
  return mode === 'auto' ? autoLevel : mode;
}

/**
 * Decide, a cada segundo, se o automático deve passar para o leve. Só olha o normal (o leve e o mínimo já são os
 * modos econômicos) e só conta amostras válidas: aba oculta, escritório parado ou sem medida (`fps` ≤ 0) zeram a conta.
 */
export class AutoGovernor {
  private slow = 0;

  /** `true` quando chegou a hora de ligar o modo leve. */
  sample(fps: number, level: PerfLevel): boolean {
    if (level !== 'normal' || !(fps > 0) || fps >= AUTO_FPS) {
      this.slow = 0;
      return false;
    }
    this.slow++;
    if (this.slow < AUTO_SECONDS) return false;
    this.slow = 0;
    return true;
  }

  reset(): void {
    this.slow = 0;
  }
}
