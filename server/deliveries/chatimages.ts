// Imagens e páginas que aparecem no chat: o agente cita (ou grava) o caminho de uma imagem e o chat mostra a
// miniatura; a página HTML que ele publica (Artifact) aparece num quadro isolado. O
// navegador nunca recebe o caminho: só um id opaco, que GET /api/chat-image/:id troca pelo arquivo (lido pelo mesmo
// FileFetcher das entregas). Só imagens e páginas, e nunca algo com cara de segredo (files.ts: pathProblem).
import { createHash } from 'node:crypto';
import { isAbsolute, normalize } from 'node:path';
import type { TerminalEntry, TerminalImage } from '../../shared/types';
import { fileType, pathProblem } from './files';

/** Ids lembrados ao mesmo tempo (os mais antigos saem primeiro). */
export const MAX_CHAT_IMAGES = 1000;
/** Imagens por mensagem. */
export const MAX_PER_ENTRY = 6;

const LINK_RE = /\]\(\s*<?([^)\s>]+?\.(?:png|jpe?g|gif|webp|svg))>?\s*\)/gi;
const BARE_RE = /(?:^|[\s(`"'])((?:\/|file:\/\/\/)[^\s`"'()<>]+?\.(?:png|jpe?g|gif|webp|svg))(?=$|[\s`"'),.;:!?])/gim;
const paths = new Map<string, { path: string; type: string }>();

const idOf = (path: string) => createHash('sha256').update(path).digest('hex').slice(0, 20);

function register(raw: string, kind: 'image' | 'page' = 'image'): TerminalImage | undefined {
  let p = raw.trim();
  try {
    p = decodeURIComponent(p);
  } catch {
    // fica como veio
  }
  if (p.startsWith('file://')) p = p.slice(7);
  if (!isAbsolute(p)) return undefined;
  p = normalize(p);
  const ft = fileType(p);
  if (!ft || ft.kind !== kind || pathProblem(p)) return undefined;
  const id = idOf(p);
  paths.delete(id);
  paths.set(id, { path: p, type: ft.type });
  if (paths.size > MAX_CHAT_IMAGES) paths.delete(paths.keys().next().value as string);
  return { id, name: p.split('/').pop() ?? p };
}

/** O arquivo de um id devolvido por `annotateImages` (ou undefined se o id é desconhecido). */
export function chatImage(id: string): { path: string; type: string } | undefined {
  return paths.get(id);
}

/** Acrescenta `images` às respostas do agente (caminhos citados) e às gravações (Write) de imagem, e `previews` às páginas do Artifact. */
export function annotateImages(e: TerminalEntry): TerminalEntry {
  if (e.kind === 'tool' && e.file !== undefined) {
    const { file, ...rest } = e;
    const img = e.tool === 'Write' ? register(file) : undefined;
    const page = e.tool === 'Artifact' ? register(file, 'page') : undefined;
    return { ...rest, ...(img ? { images: [img] } : {}), ...(page ? { previews: [page] } : {}) };
  }
  const found: string[] = [];
  if (e.kind === 'assistant') {
    if (!e.text.includes('.')) return e;
    for (const m of e.text.matchAll(LINK_RE)) found.push(m[1]);
    for (const m of e.text.matchAll(BARE_RE)) found.push(m[1]);
  } else return e;
  const images: TerminalImage[] = [];
  for (const f of found) {
    const img = register(f);
    if (img && !images.some((i) => i.id === img.id)) images.push(img);
    if (images.length >= MAX_PER_ENTRY) break;
  }
  return images.length ? { ...e, images } : e;
}
