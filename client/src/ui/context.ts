// Contexto compartilhado entre os componentes da interface.
import type { AccountInfo, AgentInfo } from '../../../shared/types';
import type { OfficeStore } from '../net/store';
import type { Selection, WorldApi } from '../world/api';
import type { UiPrefs } from './prefs';

export interface UiComponent {
  /** Chamado no máximo uma vez por quadro, quando algo mudou (snapshot, seleção, relógio...). */
  render(): void;
}

export type PanelName = 'sidebar' | 'feed';

/** Opções de uma janela de terminal (várias podem estar abertas ao mesmo tempo: ui/termwindows.ts). */
export interface WindowOptions {
  /** Chave da posição guardada no navegador; o chat e o interativo do mesmo slot dividem a chave. */
  moveKey?: string;
  /** Deslocamento (px) do lugar padrão: cada slot nasce um pouco abaixo e à direita do anterior. */
  offset?: number;
  /** Trocar o agente desta janela (clique numa aba). Padrão: o roteador escolhe a janela. */
  openAgent?: (agentId: string) => void;
}

/**
 * Uma janela de terminal por agente (várias abertas ao mesmo tempo): o interativo quando a sessão roda dentro do
 * Habblaud (pty); senão o de leitura (com "Assumir daqui" para passar a ser interativo). Montado em ui/termwindows.ts.
 */
export interface TerminalRouter {
  /** Agente da janela de terminal que está na frente (qualquer um dos dois tipos), ou null. */
  readonly openAgentId: string | null;
  /** Este agente tem uma janela de terminal aberta (em qualquer posição)? */
  showing(agentId: string): boolean;
  open(agentId: string, opener?: HTMLElement | null): void;
  toggle(agentId: string, opener?: HTMLElement | null): void;
  /** O terminal deste agente seria o interativo. */
  interactive(agentId: string): boolean;
  /** Dá para abrir algum terminal agora (acesso local, fora do timelapse). */
  readonly available: boolean;
  /** Terminal interativo ligado (abrir sessões novas, assumir, encerrar). */
  readonly interactiveEnabled: boolean;
  /** A janela de chat (leitura da conversa + caixa de mensagem) está disponível. */
  readonly chatAvailable: boolean;
  /**
   * Troca a janela do agente entre o terminal interativo e o chat, sem encerrar nada: o pty continua rodando e a
   * conversa é a mesma. Só vale quando o agente já tem pty (se não tem, o caminho é "Assumir daqui").
   */
  switchView(agentId: string): void;
  /**
   * Garante a janela interativa do agente à frente (chat → interativo, ou só traz para a frente). Diferente de
   * `switchView`, nunca volta para o chat. Sem pty para o agente, abre o que o roteador abriria.
   */
  showInteractive(agentId: string): void;
  /** Sessão nova do Claude Code na pasta, aberta no terminal interativo. */
  newSession(cwd: string, account?: string): Promise<void>;
}

export type HelpSection = 'usage' | 'codex';

export interface UiContext {
  readonly store: OfficeStore;
  /** Janela de terminal (definida depois que os painéis existem). */
  terminals?: TerminalRouter;
  readonly world: WorldApi;
  readonly root: HTMLElement;
  readonly prefs: Readonly<UiPrefs>;
  updatePrefs(patch: Partial<UiPrefs>): void;
  /** Relógio do servidor (corrige a diferença entre o relógio local e o do servidor). */
  now(): number;
  account(id: string): AccountInfo | undefined;
  agent(id: string): AgentInfo | undefined;
  selection(): Selection;
  /**
   * Seleciona no mundo (a UI se sincroniza pelo onSelect). Com `focus`, a câmera vai até o alvo dentro da
   * área livre (fora dos painéis) e o foco é refeito quando painéis abrem/fecham, até o usuário mexer na câmera.
   */
  select(sel: Selection, opts?: { focus?: boolean }): void;
  /** Leva a câmera de novo até a seleção atual (botão Centralizar). */
  focusSelection(): void;
  /** Comandos de câmera dos botões/atalhos da UI (cancelam o foco mantido). */
  camera(action: 'overview' | 'zoomIn' | 'zoomOut'): void;
  /** Agenda uma renderização no próximo quadro. */
  invalidate(): void;
  /** Abre/fecha um painel (sem argumento: alterna). */
  togglePanel(name: PanelName, open?: boolean): void;
  isPanelOpen(name: PanelName): boolean;
  /** Tela estreita: painéis viram gavetas sobrepostas. */
  isNarrow(): boolean;
  /** Anuncia um texto para leitores de tela. */
  announce(text: string): void;
  focusSearch(): void;
  /** Abre a ajuda; com `section`, rola até ela (ex.: "usage" = Contas e uso). */
  openHelp(section?: HelpSection): void;
  toggleSettings(): void;
  /** Abre/fecha a janela do Habblaud World (o botão da barra do topo; ui/world/world-dialog.ts). */
  toggleWorld(): void;
  /** Abre o campo de renomear a sala perto do ponto (px da janela); botão direito na sala (ui/roomrename.ts). */
  renameRoom?(roomId: string, at: { x: number; y: number }): void;
  /**
   * (Opcional) "Ver como os outros veem": abre a cidade do Habblaud World e entra no próprio prédio (a cena Visita). Só
   * existe com a cena Mundo montada (app.ts).
   */
  visitOwnBuilding?(): void;
  /** Abre as configurações na seção "Sobre" (versão em uso e versão nova). */
  openAbout(): void;
  /** Abre/fecha o timelapse do dia (ui/timelapse.ts). */
  toggleTimelapse(): void;
  isTimelapseOpen(): boolean;
}
