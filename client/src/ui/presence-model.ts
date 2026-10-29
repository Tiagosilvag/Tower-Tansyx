// Presença: quem mais está com um agente aberto (funções puras, sem DOM nem rede).
import { tr } from '../../../shared/i18n';

export interface PresentUser {
  id: number;
  name: string;
  color: string;
  typing: boolean;
}

/** Os outros: tira você da lista de quem está com o agente aberto. */
export function othersOf(list: readonly PresentUser[] | undefined, meId: number | undefined): PresentUser[] {
  return (list ?? []).filter((u) => u.id !== meId);
}

function join(names: string[]): string {
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return tr('{0} e {1}', [names[0]!, names[1]!]);
  return tr('{0}, {1} e mais {2}', [names[0]!, names[1]!, names.length - 2]);
}

/** Texto curto para a barra: "ansysar está digitando…" ou "ansysar e luciano estão aqui". Vazio sem ninguém. */
export function presenceLabel(others: readonly PresentUser[]): string {
  if (!others.length) return '';
  const typing = others.filter((u) => u.typing).map((u) => u.name);
  if (typing.length) return typing.length === 1 ? tr('{0} está digitando…', [typing[0]!]) : tr('{0} estão digitando…', [join(typing)]);
  return others.length === 1 ? tr('{0} está aqui', [others[0]!.name]) : tr('{0} estão aqui', [join(others.map((u) => u.name))]);
}
