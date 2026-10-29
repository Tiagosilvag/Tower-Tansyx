// Documentos citados no chat: o texto da resposta nomeia um .md (relativo ao projeto do agente, ou absoluto) e o cliente
// pede para abrir. O texto do chat é dado de fora, então aqui só passa markdown, fora de pastas de segredo e dentro de uma
// pasta de projeto que alguma conta conhece (ou das temporárias); o resto é recusado.
import { isAbsolute, join, normalize } from 'node:path';
import { tr } from '../../shared/i18n';
import { checkFile, extensionOf, insideKnownFolder, pathProblem, tempRoots } from './files';

const DOC_EXTENSIONS = new Set(['md', 'markdown']);

export interface DocFolders {
  accountDirs: readonly string[];
  /** Sem acesso ao disco aqui (Docker): só confere o caminho pelo texto; quem lê é o auxiliar do host. */
  textOnly?: boolean;
}

/** Caminho absoluto do documento pedido, ou o motivo da recusa. */
export function resolveDoc(project: string, path: string, folders: DocFolders): { path: string } | { error: string } {
  if (!path || path.includes('\0') || project.includes('\0') || path.length > 1024 || project.length > 1024) return { error: tr('caminho inválido') };
  if (!DOC_EXTENSIONS.has(extensionOf(path))) return { error: tr('só markdown abre aqui') };
  if (!isAbsolute(path) && !isAbsolute(project)) return { error: tr('caminho inválido') };
  const abs = normalize(isAbsolute(path) ? path : join(project, path));
  const bad = pathProblem(abs);
  if (bad) return { error: bad };
  if (folders.textOnly) return { path: abs };
  const c = checkFile(abs);
  if ('error' in c) return c;
  if (!insideKnownFolder(c.path, { accountDirs: folders.accountDirs, roots: tempRoots() })) return { error: tr('arquivo fora das pastas de projeto conhecidas') };
  return { path: c.path };
}
