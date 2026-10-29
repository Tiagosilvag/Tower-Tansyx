// Arquivos anexados aos cartões do Kanban, no disco: <raiz>/<id do cartão>/<id do arquivo>. O nome do arquivo no disco é só
// o número, então nada que o usuário digita vira caminho. Os metadados (nome, tipo, tamanho, quem enviou) ficam no banco.
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** O que o navegador pode mostrar na própria página (imagem, PDF, texto simples). O resto só baixa. */
const INLINE: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  csv: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  json: 'text/plain; charset=utf-8',
  sql: 'text/plain; charset=utf-8',
};

/**
 * Como entregar o arquivo: tipos seguros abrem na tela; qualquer outro (HTML, SVG, executáveis...) vai como download com tipo
 * genérico, para nunca rodar script na origem do Habblaud.
 */
export function delivery(name: string): { type: string; inline: boolean } {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  const type = INLINE[ext];
  return type ? { type, inline: true } : { type: 'application/octet-stream', inline: false };
}

export class KanbanFiles {
  constructor(readonly root: string) {}

  pathOf(cardId: number, fileId: number): string {
    return join(this.root, String(cardId), String(fileId));
  }

  write(cardId: number, fileId: number, data: Buffer): void {
    const dir = join(this.root, String(cardId));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = this.pathOf(cardId, fileId);
    writeFileSync(file, data, { mode: 0o600 });
    chmodSync(file, 0o600);
  }

  /** Tamanho em disco, ou undefined se o arquivo sumiu. */
  sizeOf(cardId: number, fileId: number): number | undefined {
    const file = this.pathOf(cardId, fileId);
    return existsSync(file) ? statSync(file).size : undefined;
  }

  remove(cardId: number, fileId: number): void {
    rmSync(this.pathOf(cardId, fileId), { force: true });
  }

  /** Cartão apagado: some a pasta dele inteira. */
  removeCard(cardId: number): void {
    rmSync(join(this.root, String(cardId)), { recursive: true, force: true });
  }
}
