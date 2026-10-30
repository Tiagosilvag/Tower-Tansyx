# KI — Tower Tansyx

Última atualização: 30/10/2026. O histórico do que foi feito está no [`Diario-de-Projeto.md`](Diario-de-Projeto.md).

> Este arquivo é commitado em repositório **público**. Por isso fica só o que é seguro para qualquer leitor: nada de credenciais,
> infraestrutura (hosts, IPs, portas, caminhos do servidor, deploy), esquema de banco, endpoints internos, fluxos de autenticação,
> regras de permissão nem dados de pessoas. Esses detalhes ficam fora do repositório. Vulnerabilidades não corrigidas nunca entram
> aqui: o dono é avisado na conversa.

## Onde está cada coisa

| O quê | Onde |
|---|---|
| Servidor (Node, sem dependências de runtime) | `server/` |
| Página no navegador (TypeScript) | `client/` |
| Tipos e traduções comuns | `shared/` (traduções em `shared/locales/`) |
| Contas de usuário | `server/users/`, `client/src/ui/users*.ts` |
| Presença e "digitando" | `server/users/presence*.ts`, `client/src/ui/presence*.ts` |
| Marcação de quem escreveu | `server/users/senders.ts`, `client/src/ui/rows.ts` |
| Kanban | `server/kanban/`, `client/src/ui/kanban*.ts`, `shared/kanban.ts` |
| Comando dos agentes para o Kanban | `scripts/tower-kanban` |
| Entregas (arquivos do agente) | `server/deliveries/`, `client/src/ui/deliveries.ts` |
| Documento `.md` citado no chat | `server/deliveries/docs.ts`, `client/src/ui/docviewer.ts` |
| Compactação visível | `server/pty/compaction.ts` |
| Conversa anterior | `server/sources/earlier.ts` |
| Regras de código e contribuição | `CLAUDE.md`, `CONTRIBUTING.md` |

## 0. Estado atual

- **Rodando:** tudo o que consta no diário até 29/10/2026 (contas, marcação, presença, Entregas com texto, Kanban com Revisão e
  anexos, compactação, conversa anterior, filtro "Só prompts" por padrão, janela de documentos `.md`).
- **Pronto esperando subir:** correção do texto grande no iPhone e **renomear a sessão** pelo lápis no painel do agente (manda
  `/rename` ao Claude Code; só com a sessão aberta pelo Tower e parada), janelas móveis que não passam das laterais e o
  **seletor de divisões da tela** (organizar as janelas). [CONFIRMAR no aparelho / em uso real]
- **Riscos de negócio e entrega:**
  - O repositório é público e o histórico do git ainda contém versões antigas do KI e do diário com detalhes de ambiente
    (sem credenciais). Reescrever o histórico ou criar repositório novo só com ordem do dono.
  - Alguns arquivos de `docs/` e `RESUMO-DO-TRABALHO.md`/`PLANO-PTY-ACCESS.md` têm detalhes de ambiente e foram escritos antes
    das regras atuais. [CONFIRMAR destino: remover do repositório, deixar só local ou reescrever genérico]
  - Presença e conversa anterior não foram conferidas no navegador por mim; o dono usa em produção. [CONFIRMAR]

## 1. Contexto

Tower Tansyx é o Habblaud (escritório virtual em pixel art que mostra o que os agentes do Claude Code e do Codex estão fazendo),
usado por uma equipe pequena de sócios. Na tela o nome é "Tower Tansyx"; no código continua `habblaud`.

- Texto visível sempre por `tr('texto em PT')`, com en/es/fr em `shared/locales/` (`npm run i18n:check` precisa fechar).
- Toda mudança visível entra em "Não lançado" do `CHANGELOG.md`.
- **Não mexer em `shared/world/` nem `server/world/`** (dados verdadeiros do Habblaud World; ver `CLAUDE.md`).

## 2. Decisões do dono

| Decisão | Motivo |
|---|---|
| Deploy só com aprovação explícita a cada vez | Evitar mudança em produção sem o dono saber |
| Acesso por contas de usuário, cada sócio com a sua | Saber quem fez o quê (marcação, presença, Kanban) |
| Marcação de mensagem com degradê leve na cor do usuário | Diferenciar o que foi dito da resposta do agente sem poluir |
| Presença como aviso, sem bloquear ninguém | Não atrapalhar quem trabalha junto |
| Revisão no Kanban pede motivo (pelo comando dos agentes) | Quem revisa sabe o que olhar; a página não obriga, para não atrapalhar o arrastar |
| Chat abre sempre em "Só prompts" | Leitura mais limpa; a escolha vale só enquanto a janela está aberta |
| Documento `.md` abre em janela flutuante como o Kanban | Ler sem bloquear o escritório |
| PowerPoint e similares só baixam | Não há visualizador confiável |
| Quadros do Kanban por projeto: adiado | "Depois voltamos nesse tema" |
| Repositório público: KI e diário genéricos | Regra de segurança das diretrizes globais |

## 3. Comandos e convenções

- Testes: `npx vitest run`, com `HABBLAUD_PTY` vazia (`env HABBLAUD_PTY= npx vitest run`). Também `npm run typecheck`,
  `npm run i18n:check`, `npm run build`.
- Mudanças de banco entram como migração nova, em ordem; nunca se edita uma migração já publicada.
- Edição de acentos por script pode gravar combinantes literais; confira depois.
- Toda tarefa que muda algo atualiza o diário e, se o conhecimento mudou, este arquivo.

### Armadilhas

- Testes ou instâncias de teste não devem herdar `HABBLAUD_PTY`: o terminal interativo se anexaria a sessões reais. Use o valor
  vazio e isole os diretórios de dados (`HABBLAUD_DATA_DIR`, `HABBLAUD_USAGE_DIR`, `HABBLAUD_DB`) em pasta temporária.
- `server/test/statusline.test.ts` falha quando a suíte roda com o usuário administrador do sistema (conhecido; ignore).
- `server/index.users.test.ts` sobe um servidor de verdade; não rode sem necessidade.

## 4. Contas de usuário

Modo opcional (`HABBLAUD_REMOTE_USERS`): contas num banco SQLite embutido, senha só como hash, sessão por cookie e freio de
tentativas. Acesso total pela sessão logada é opt-in (`HABBLAUD_REMOTE_FULL`). Detalhes de configuração e segurança ficam fora do
repositório.

## 5. Funcionalidades

- **Janelas móveis e divisões da tela:** chat, terminal, Kanban e documentos são janelas flutuantes (`client/src/ui/movable.ts`):
  arrastam, esticam, expandem na tela toda (barra superior incluída) e não passam das laterais. O botão de grade na barra de cada
  uma (`client/src/ui/layouts.ts`) abre oito divisões (colunas, terços, quartos...): encaixa só a janela ou distribui todas as
  abertas, da mais usada para a menos usada. Escondido em tela estreita; não reajusta sozinho se o navegador mudar de tamanho.
- **Excluir a última mensagem:** botão no chat (só a última mensagem do usuário, agente parado, sessão aberta pelo Tower), com janela de
  confirmação. Faz o Claude Code voltar a conversa (`DELETE_LAST_STEPS`, `client/src/ui/session-info.ts`) e o servidor passa a esconder
  as entradas apagadas para todos (`server/terminal/removed.ts`, filtro em `server/http/terminal.ts`). O transcript não é alterado.
  Depende do menu de voltar a conversa do Claude Code. [CONFIRMAR em uso real]
- **Marcação de quem escreveu:** o chat mostra o prompt com degradê leve na cor do usuário, faixa fina e nome. O servidor guarda só
  (hora, texto normalizado, usuário) por 30 dias e casa com o transcript; o agente nunca recebe o nome. Não marca mensagem digitada
  fora da página nem registrada muito depois do envio; duas pessoas com o mesmo texto quase junto podem ter as marcas trocadas.
- **Presença em tempo real:** avatares/pílulas de quem mais está com o agente aberto (barra do chat, do terminal e linha do agente) e
  "está digitando…". Só em memória; some sozinha se a pessoa para de avisar. É só aviso: não bloqueia ninguém.
- **Compactação visível:** o transcript não registra nada durante a compactação; o servidor lê a saída do terminal do agente e o chat
  mostra "Compactando a conversa…" (com tmux, confere também a tela do terminal, porque o Claude Code redesenha só o contador). Só cobre sessões abertas no terminal interativo do Habblaud. Depende do texto em inglês do
  Claude Code ("Compacting conversation"). Botão **Compactar** na caixa de mensagem (`client/src/ui/composer.ts`): dois toques,
  só com o agente parado e sessão do terminal interativo; envia `/compact` e o Enter em envios separados (um bloco com Enter no
  meio pode ser tratado como texto colado). [CONFIRMAR em uso real]
- **Conversa anterior:** o chat carrega só o fim do transcript; o botão "Carregar conversa anterior" lê 500 entradas por vez para
  trás. O teto de itens em tela sobe para não descartar o que o usuário pediu.
- **Filtro do chat:** abre em "Só prompts" (`DEFAULT_TERMINAL_FILTER`).
- **Entregas:** só arquivos que o próprio agente entregou, nunca algo com cara de segredo. Visualiza imagem, PDF, vídeo, HTML (quadro
  isolado) e texto (md formatado, sql, json, yaml, código comum). Word, PowerPoint, Excel e zip só baixam.
- **Documento citado no chat:** caminho de `.md` escrito como código na resposta é clicável e abre formatado numa janela flutuante
  (arrasta, redimensiona, expande, Atualizar, Copiar, Abrir). O texto do chat vem de fora, então o servidor só serve markdown de pasta
  de projeto conhecida, sem nome de segredo, e ignora o cache (o agente reescreve o arquivo). Texto solto, sem crase, não vira link.
- **Novo agente / projeto novo:** lista de projetos recentes com pesquisa (a partir de 5 pastas), sem pastas inexistentes nem a home;
  "+ Projeto novo" cria a pasta, inicia o git e abre a primeira sessão com a ideia.
- **Perguntas do agente:** cartão com as opções e a resposta no chat, inclusive com várias perguntas.

## 6. Kanban

Ideias e tarefas num quadro Geral e um por projeto, em banco SQLite. Colunas: `ideias`, `a_fazer`, `fazendo`, `revisao`, `feito`
(`COLUMNS` em `shared/kanban.ts`). Janela flutuante, atualiza sozinha quando alguém mexe (consulta leve a cada 3 s, pausa com a aba
escondida ou o campo em edição) e tem botão de atualizar.

- Cartão: responsável (avatar na cor da pessoa; cartão novo nasce com quem o criou), anexos (até 20 por cartão, 15 MB cada; imagem,
  PDF e texto abrem na tela, o resto só baixa; Ctrl+V cola print), comentários e histórico de quem mexeu.
- Agentes usam o comando `tower-kanban` (script em `scripts/`), instalado no PATH da máquina e ensinado pelo `CLAUDE.md` do usuário
  de cada conta do Claude Code. O agente não sabe quem mandou a mensagem: só usa `--as` se a pessoa se identifica.
- **Revisão:** mover um cartão para `revisao` pelo comando exige `--comment` com o motivo. A página não obriga. Revisão conta como
  trabalho aberto.

## 7. Pendências

Veja "Pendente" na entrada mais recente do diário e a lista "Em aberto" no fim dele.
