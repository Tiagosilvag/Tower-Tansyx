# KI — Conhecimento do projeto (Tower Tansyx)

Base de conhecimento: **como as coisas funcionam e por quê**. O histórico do que foi feito está no [`DIARIO.md`](DIARIO.md).
As regras de código estão em [`CLAUDE.md`](CLAUDE.md) e [`CONTRIBUTING.md`](CONTRIBUTING.md).

> Este arquivo é commitado em repositório público. Não registre aqui credenciais, infraestrutura (hosts, IPs, portas, caminhos
> do servidor, deploy), esquema de banco, endpoints internos, fluxos de autenticação nem dados de pessoas. Detalhes
> operacionais ficam fora do repositório.

## 1. O que é

Tower Tansyx é o Habblaud (escritório virtual em pixel art que mostra o que os agentes do Claude Code e do Codex estão fazendo),
usado por uma equipe pequena. Na tela o nome é "Tower Tansyx"; no código continua `habblaud`.

- `server/`: Node sem dependências de runtime. `client/`: TypeScript no navegador. `shared/`: tipos e traduções comuns.
- Texto visível sempre por `tr('texto em PT')`, com en/es/fr em `shared/locales/` (`npm run i18n:check` precisa fechar).
- Toda mudança visível entra em "Não lançado" do `CHANGELOG.md`.
- **Não mexer em `shared/world/` nem `server/world/`** (dados verdadeiros do Habblaud World; ver `CLAUDE.md`).

## 2. Comandos e convenções

- Testes: `npx vitest run`, com a variável `HABBLAUD_PTY` vazia (`env HABBLAUD_PTY= npx vitest run`). Também: `npm run typecheck`,
  `npm run i18n:check`, `npm run build`.
- Mudanças de banco entram como migração nova, em ordem; nunca se edita uma migração já publicada.
- Deploy só com a aprovação do dono do projeto; o passo a passo fica fora do repositório.
- Toda tarefa que muda algo atualiza o `DIARIO.md` e, se o conhecimento mudou, este arquivo.

## 3. Armadilhas

- Testes ou instâncias de teste não devem herdar `HABBLAUD_PTY`: o terminal interativo se anexaria a sessões reais. Use o valor vazio
  e isole os diretórios de dados (`HABBLAUD_DATA_DIR`, `HABBLAUD_USAGE_DIR`, `HABBLAUD_DB`) em pasta temporária.
- `server/test/statusline.test.ts` falha quando a suíte roda com o usuário administrador do sistema (conhecido; ignore).
- `server/index.users.test.ts` sobe um servidor de verdade; não rode sem necessidade.
- Edição de acentos por script pode gravar combinantes literais; confira depois.

## 4. Contas de usuário

Modo opcional (`HABBLAUD_REMOTE_USERS`): contas num banco SQLite embutido, senha só como hash, sessão por
cookie e freio de tentativas. Acesso total pela sessão logada é opt-in (`HABBLAUD_REMOTE_FULL`). Detalhes de configuração e de
segurança ficam fora do repositório. Código em `server/users/` e `client/src/ui/users*.ts`.

## 5. Funcionalidades

- **Marcação de quem escreveu:** o chat mostra o prompt com degradê leve na cor do usuário, faixa fina e nome. O servidor guarda só
  (hora, texto normalizado, usuário) por 30 dias e casa com o transcript; o agente nunca recebe o nome. Não marca mensagem
  digitada fora da página nem registrada muito depois do envio; duas pessoas com o mesmo texto quase junto podem ter as marcas
  trocadas.
- **Presença em tempo real:** avatares/pílulas de quem mais está com o agente aberto (barra do chat, do terminal e linha do agente) e
  "está digitando…". Só em memória; some sozinha se a pessoa para de avisar. Código em `server/users/presence*.ts` e
  `client/src/ui/presence*.ts`. É só aviso: não bloqueia ninguém.
- **Compactação visível:** o transcript não registra nada durante a compactação; o servidor lê a saída do terminal do agente
  (`server/pty/compaction.ts`) e o chat mostra "Compactando a conversa…". Só cobre sessões abertas no terminal interativo do Habblaud.
  Depende do texto em inglês do Claude Code ("Compacting conversation").
- **Conversa anterior:** o chat carrega só o fim do transcript; o botão "Carregar conversa anterior" lê 500 entradas por vez
  para trás (`server/sources/earlier.ts`; no cliente, `TerminalLog.prepend`). O teto de itens em tela sobe para não descartar o que o
  usuário pediu.
- **Filtro do chat:** abre em "Só prompts" (`DEFAULT_TERMINAL_FILTER`); a escolha vale só enquanto a janela está aberta.
- **Entregas:** só arquivos que o próprio agente entregou, nunca algo com cara de segredo. Visualiza imagem, PDF, vídeo, HTML (quadro
  isolado) e texto (md formatado, sql, json, yaml, código comum). Word, PowerPoint, Excel e zip só baixam.
  Código em `server/deliveries/` e `client/src/ui/deliveries.ts`.
- **Documento citado no chat:** caminho de `.md` escrito como código na resposta é clicável e abre formatado (`client/src/ui/docviewer.ts`,
  `server/deliveries/docs.ts`). O texto do chat vem de fora, então o servidor só serve markdown de pasta de projeto conhecida, sem
  nome de segredo, e ignora o cache (o agente reescreve o arquivo). Texto solto, sem crase, não vira link.
- **Novo agente / projeto novo:** lista de projetos recentes com pesquisa (a partir de 5 pastas), sem pastas inexistentes nem a
  home; "+ Projeto novo" cria a pasta, inicia o git e abre a primeira sessão com a ideia (`server/spawn/`, `client/src/ui/spawn.ts`).
- **Perguntas do agente:** cartão com as opções e a resposta no chat, inclusive com várias perguntas (`termtools.ts`, `termask.ts`).

## 6. Kanban

Ideias e tarefas num quadro Geral e um por projeto, em banco SQLite. Colunas: `ideias`, `a_fazer`, `fazendo`, `revisao`, `feito`
(`COLUMNS` em `shared/kanban.ts`). Janela flutuante, atualiza sozinha quando alguém mexe (consulta leve a cada 3 s, pausa com a aba
escondida ou o campo em edição) e tem botão de atualizar.

- Cartão: responsável (avatar na cor da pessoa; cartão novo nasce com quem o criou), anexos (até 20 por cartão, 15 MB cada; imagem,
  PDF e texto abrem na tela, o resto só baixa; Ctrl+V cola print), comentários e histórico de quem mexeu.
- Agentes usam o comando `tower-kanban` (script em `scripts/`), instalado no PATH da máquina e ensinado pelo `CLAUDE.md` do usuário de
  cada conta do Claude Code. O agente não sabe quem mandou a mensagem: só usa `--as` se a pessoa se identifica.
- **Revisão:** mover um cartão para `revisao` pelo comando exige `--comment` com o motivo (o comando move e comenta). A página não
  obriga. Revisão conta como trabalho aberto.
- Código em `server/kanban/` e `client/src/ui/kanban*.ts`.

## 7. Pendências

Veja o fim de `DIARIO.md` ("Em aberto").
