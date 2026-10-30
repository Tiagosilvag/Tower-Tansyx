// Mensagens apagadas da conversa pelo botão "Excluir" do chat. O Claude Code volta a conversa dele, mas o arquivo do
// transcript só cresce, então o servidor guarda aqui as faixas de tempo apagadas de cada conversa e o chat esconde as
// entradas dentro delas, para todo mundo. Nada é mexido no transcript.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TerminalEntry } from '../../shared/types';
import { errMsg, log } from '../log';
import { tr } from '../../shared/i18n';

/** [de, até] em ms: as entradas com `at` nesse intervalo estão apagadas. */
type Range = [number, number];

const MAX_RANGES = 50;
const MAX_CONVERSATIONS = 200;

export class RemovedStore {
  private byPath = new Map<string, Range[]>();

  /** `file` null = só em memória (testes ou diretório de dados indisponível). */
  constructor(private readonly file: string | null) {}

  load(): void {
    if (!this.file) return;
    try {
      const j = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>;
      for (const [path, v] of Object.entries(j)) {
        if (!Array.isArray(v)) continue;
        const ranges = v.filter((r): r is Range => Array.isArray(r) && r.length === 2 && Number.isFinite(r[0]) && Number.isFinite(r[1]));
        if (ranges.length) this.byPath.set(path, ranges.slice(-MAX_RANGES));
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(tr('removed.json ilegível ({0}); começando do zero.', [errMsg(err)]));
    }
  }

  /** Marca como apagado tudo da conversa `path` entre `from` e `to`. */
  add(path: string, from: number, to: number): void {
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return;
    const ranges = [...(this.byPath.get(path) ?? []), [from, to] as Range].slice(-MAX_RANGES);
    this.byPath.delete(path);
    this.byPath.set(path, ranges);
    while (this.byPath.size > MAX_CONVERSATIONS) this.byPath.delete(this.byPath.keys().next().value as string);
    this.flush();
  }

  /** A entrada está numa faixa apagada da conversa `path`? */
  hides(path: string | undefined, e: TerminalEntry): boolean {
    const ranges = path ? this.byPath.get(path) : undefined;
    return !!ranges?.some(([from, to]) => e.at >= from && e.at <= to);
  }

  private flush(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.byPath)), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (err) {
      log.warnOnce(`removed-flush:${errMsg(err)}`, tr('Não deu para guardar as mensagens apagadas ({0}).', [errMsg(err)]));
    }
  }
}
