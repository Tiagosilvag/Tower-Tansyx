// Quem está logado (GET /api/me). `null` na porta local (sem login) e em qualquer erro: a página então não mostra o chip.
import type { UserInfo } from '../../../shared/types';

export async function fetchMe(): Promise<UserInfo | null> {
  try {
    const res = await fetch('/api/me', { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) return null;
    const body = (await res.json()) as { user?: UserInfo | null };
    return body.user ?? null;
  } catch {
    return null;
  }
}
