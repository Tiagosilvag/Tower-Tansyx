// Páginas da conversa mais antigas que o `init` do terminal: o terminal só carrega o fim do transcript (~4 MB, 500
// entradas). Para ler para trás, o cliente pede "as 500 entradas anteriores ao byte `before`" (o começo da linha mais antiga
// que ele já tem) e recebe o novo ponto de corte. Cada página é parseada sozinha, com um parser novo: uma ferramenta e o
// resultado dela podem cair em páginas diferentes, e o cliente junta as duas.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import type { TerminalEntry } from '../../shared/types';
import { annotateImages } from '../deliveries/chatimages';
import { errMsg, log } from '../log';
import type { TerminalParser } from './terminal';
import { tr } from '../../shared/i18n';

export const EARLIER_WINDOW_BYTES = 4 * 1024 * 1024;
export const EARLIER_ENTRIES = 500;
const NL = 0x0a;

export interface EarlierPage {
  entries: TerminalEntry[];
  /** Onde começa o que esta página trouxe (o `before` da próxima); 0 = não há mais nada antes. */
  before: number;
}

/**
 * Corta `entries` para as últimas `max`, sem partir as entradas de uma mesma linha do transcript (uma resposta com vários
 * blocos vira várias entradas): a página seguinte termina exatamente no começo da primeira linha mantida.
 */
export function cutAtLine(starts: readonly number[], max: number): number {
  let i = Math.max(0, starts.length - max);
  while (i > 0 && starts[i] === starts[i - 1]) i--;
  return i;
}

export function readEarlier(
  path: string,
  before: number,
  createParser: () => TerminalParser,
  opts: { windowBytes?: number; maxEntries?: number } = {},
): EarlierPage {
  const windowBytes = opts.windowBytes ?? EARLIER_WINDOW_BYTES;
  const maxEntries = opts.maxEntries ?? EARLIER_ENTRIES;
  const fd = openSync(path, 'r');
  let buf: Buffer;
  let start: number;
  try {
    const end = Math.min(Math.max(0, Math.trunc(before)), fstatSync(fd).size);
    start = Math.max(0, end - windowBytes);
    buf = Buffer.allocUnsafe(end - start);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    buf = buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
  // Janela começando no meio de uma linha: começa na primeira linha inteira.
  let from = 0;
  if (start > 0) {
    const nl = buf.indexOf(NL);
    if (nl === -1) return { entries: [], before: 0 };
    from = nl + 1;
  }
  const parser = createParser();
  const entries: TerminalEntry[] = [];
  const starts: number[] = [];
  let pos = from;
  while (pos < buf.length) {
    let nl = buf.indexOf(NL, pos);
    if (nl === -1) nl = buf.length;
    const line = buf.toString('utf8', pos, nl);
    const lineStart = start + pos;
    pos = nl + 1;
    if (!line.trim()) continue;
    try {
      for (const e of parser.push(line)) {
        entries.push(annotateImages(e));
        starts.push(lineStart);
      }
    } catch (err) {
      log.warnOnce(`terminal-earlier:${errMsg(err)}`, tr('Terminal: linha do transcript ignorada ({0}).', [errMsg(err)]));
    }
  }
  const cut = cutAtLine(starts, maxEntries);
  if (entries.length === 0) return { entries: [], before: start > 0 ? start + from : 0 };
  const firstKept = starts[cut]!;
  // Mantendo tudo, o que falta ler começa onde a janela começou; cortando, na primeira linha mantida.
  const next = cut > 0 ? firstKept : start > 0 ? start + from : 0;
  return { entries: entries.slice(cut), before: next };
}
