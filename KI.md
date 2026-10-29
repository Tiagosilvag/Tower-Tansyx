# KI — Conhecimento do projeto (Tower Tansyx)

Leia este arquivo primeiro se você está assumindo o projeto. Ele diz **como as coisas funcionam e por quê**. O histórico do
que foi feito, dia a dia, está em [`DIARIO-DO-PROJETO.md`](DIARIO-DO-PROJETO.md). As regras de código estão em
[`CLAUDE.md`](CLAUDE.md) e [`CONTRIBUTING.md`](CONTRIBUTING.md).

> **Regra de manutenção:** toda vez que alguém (pessoa ou agente) implementar ou mudar algo, atualize este arquivo (se o
> conhecimento mudou) **e** o diário (sempre). Nunca escreva senhas, tokens ou chaves aqui.

## 1. O que é

Tower Tansyx é o Habblaud (escritório virtual em pixel art que mostra o que os agentes do Claude Code e do Codex estão
fazendo) rodando num servidor Proxmox, usado por sócios. Na tela e nas notificações o nome é "Tower Tansyx"; no código e
nos serviços continua `habblaud`.

- `server/`: Node sem dependências de runtime. `client/`: TypeScript no navegador. `shared/`: tipos e traduções comuns.
- Texto visível sempre por `tr('texto em PT')`, com en/es/fr em `shared/locales/` (`npm run i18n:check` precisa fechar).
- Toda mudança visível entra em "Não lançado" do `CHANGELOG.md`.
- **Não mexer em `shared/world/` nem `server/world/`** (dados verdadeiros do Habblaud World; ver `CLAUDE.md`).

## 2. Onde está e como entra

| Item | Valor |
|---|---|
| Repositório | `github.com/tansyxtech/Tower-Tansyx` (conta `tansyxtech`) |
| Branch de produção | `claude/adoring-goldberg-gnh2bj` |
| Código em produção | `/root/habblaud` (checkout dessa branch) |
| Serviço | `systemctl restart habblaud` (`node dist/server/index.js`) |
| Terminais | tmux (`tmux -L habblaud`, sessões `habblaud-*`); sobrevivem ao reinício (`KillMode=process`) |
| Acesso hoje | túnel Cloudflare → `https://towertansyx.coffetech.com.br`; porta principal 4747 (só loopback), porta remota 4748 com login |
| Caddy | aposentado (serviço inativo e desabilitado em 2026-10-29); o túnel aponta para a porta remota 4748. Para voltar: túnel de volta a `http://127.0.0.1:8080` e `systemctl enable --now caddy` |

Trabalho novo é feito num worktree em `/root/projetos/Tower-Tansyx/.claude/worktrees/<nome>` e integrado na branch de
produção.

### Fluxo de deploy (só com aprovação do dono)
1. Testes: `env HABBLAUD_PTY= npx vitest run --exclude server/index.users.test.ts`, `npm run typecheck`, `npm run i18n:check`.
2. Commit no worktree e `git push origin HEAD:claude/adoring-goldberg-gnh2bj`.
3. No servidor: `git -C /root/habblaud pull --ff-only`, `npm --prefix /root/habblaud run build`, `systemctl restart habblaud`.
4. Conferir `systemctl is-active habblaud`, `/api/health` (200) e `tmux -L habblaud ls`.

O dono (Tiago) aprova cada deploy ("Pode fazer o deploy"). O sistema de permissões do Claude Code pode negar o deploy; nesse
caso o dono roda o comando com `!` no prompt.

## 3. Armadilhas conhecidas

- **`HABBLAUD_PTY=1` é herdado.** Testes e instâncias de teste NÃO devem ligar o PTY: ele se anexa às sessões tmux de
  produção. Rode testes com `env HABBLAUD_PTY=` e isole `HABBLAUD_DATA_DIR`, `HABBLAUD_USAGE_DIR` e `HABBLAUD_DB` em
  pasta temporária.
- `server/test/statusline.test.ts` falha rodando como root (o `chmod` não bloqueia). É conhecido, ignore.
- `server/index.users.test.ts` sobe um servidor filho em portas reais (inclusive `0.0.0.0` por segundos): não rode sem
  necessidade.
- Heredocs e comandos compostos podem ser recusados pelo sandbox: use scripts em arquivo.
- Python gravando combinantes unicode pode virar literal; confira acentos depois de editar por script.
- Se o Edit falhar por `"` ou acento, ancore em texto só ASCII.

## 4. Login e usuários (modo de usuários)

Ligado por `HABBLAUD_REMOTE_USERS=1`. Todos os usuários têm o mesmo poder e qualquer um administra as contas.

- **Banco:** SQLite embutido do Node (`node:sqlite`), arquivo `~/.habblaud/habblaud.db` (`HABBLAUD_DB` muda), modo 0600.
  Migrações em `server/db/db.ts` (`MIGRATIONS`; **nunca edite uma já publicada**, acrescente outra).
- **Senha:** scrypt; mínimo de **8 caracteres** (`MIN_PASSWORD` em `server/users/http.ts` e `client/src/ui/users-model.ts`).
  O `remote:setup` do usuário único antigo ainda pede 10.
- **Sessão:** cookie `habblaud_remote` (30 dias, `HttpOnly; SameSite=Strict`); trocar a senha ou remover o usuário
  derruba as sessões dele na hora.
- **Freio de tentativas** (`UserThrottle` em `server/users/auth.ts`): 5 erros trancam o par (usuário, IP) por 15 min;
  retaguarda de 20 erros/60 s por IP; teto de 100 erros/h por nome (o teto já estourado não é despejado por enchente de
  nomes, ver diário de 2026-10-29). IP vem de `CF-Connecting-IP` só atrás do túnel (`trustProxyProto`).
- **Acesso total** (`HABBLAUD_REMOTE_FULL=1`): a sessão logada passa a usar terminal interativo, agentes e projeto novo.
  Hooks, plugins, Codex, auxiliar do host e World continuam só locais. Modo de usuários e acesso total recusam subir em
  HTTP puro fora do loopback (a receita usa `HABBLAUD_REMOTE_HOST=127.0.0.1` + `HABBLAUD_REMOTE_INSECURE_HTTP=1` atrás do túnel).
- **Comandos:** `npm run users:add|passwd|list`. A tela fica no menu do chip de usuário (Usuários, Trocar minha senha, Sair).
- **Código:** `server/users/` (`store`, `auth`, `http`, `identity`, `senders`, `typing`), `server/http/remote.ts` (portão),
  `scripts/users.ts`, `client/src/ui/usermenu.ts`, `users.ts`, `users-model.ts`.
- Usuários hoje: `tiago`, `ansysar`, `luciano`. Senhas nunca são legíveis (só hash); quem esquecer troca por Usuários ou
  `npm run users:passwd <login>`.

## 5. Quem escreveu cada mensagem (marcação no chat)

- Cada usuário tem uma cor. O prompt enviado pela página aparece no chat com degradê leve da cor, faixa fina e nome.
- **O Claude nunca recebe o nome.** O servidor guarda só (hora, texto normalizado, usuário) na tabela `message_senders`
  por 30 dias e casa isso com o transcript ao montar a conversa (`SenderLog.annotate`, aplicado em
  `server/http/terminal.ts`).
- Entradas: `POST /api/messages` (caixa de mensagem) e teclas do terminal interativo (`TypedLines` remonta a linha no Enter).
- Limites: não marca mensagem digitada no terminal do próprio computador, nem registrada no transcript >15 min depois;
  duas pessoas mandando exatamente o mesmo texto quase juntas podem ter as marcas trocadas. A tela crua do terminal
  interativo não ganha cor (só o chat).

### Presença em tempo real
- Quem está com cada agente aberto e quem está digitando. Só no modo de usuários e só na memória do servidor
  (`server/users/presence.ts`; rotas `GET|POST /api/presence` em `presence-http.ts`). Quem para de avisar some em 20 s;
  "digitando" dura 6 s.
- Cliente (`client/src/ui/presence.ts`): avisa a cada 8 s os agentes com janela aberta (`terminals.showing`), manda um aviso
  extra ao digitar dentro de `.ui-term` (no máximo a cada 2,5 s; uma digitada curta agenda o aviso para quando o intervalo passar) e consulta a lista a cada 2,5 s. Aba escondida avisa lista
  vazia. A faixa (`presenceStrip`) fica nas barras do chat (`terminal.ts`) e do terminal interativo (`pty.ts`);
  `paintPresenceFaces` põe pílulas (avatar + nome na cor da pessoa; "nome digitando…" quando digita; no máximo 2 e "+N") abaixo do nome do agente (`rows.ts`, barra lateral e gaveta).
- Não bloqueia ninguém: é só aviso. Uma trava de "um escreve por vez" não existe (decisão: aviso primeiro).

## 6. Kanban

_Atualização em tempo real:_ o servidor mantém uma revisão (`GET /api/kanban/version`, sobe a cada alteração aceita; começa em
`Date.now()`). A janela aberta consulta a cada 3 s (`POLL_MS` em `kanban.ts`) e recarrega se mudou, exceto quando a tela está
ocupada (campo aberto, arrasto, cartão aberto) ou a aba está escondida. Botão ↻ força. Não há push (SSE) por enquanto.

Ideias e tarefas num quadro Geral e por projeto, no SQLite (mesmo banco). Janela flutuante como o chat (tecla K).
Código em `server/kanban/`, `client/src/ui/kanban*.ts`. Agentes podem usar via API local (`docs/kanban-agentes.md`);
a porta exposta é só leitura. O histórico de cada cartão guarda quem mexeu.

## 7. Entregas (arquivos que o agente entrega)

`server/deliveries/`. Só mostra arquivos que o próprio agente entregou, nunca algo com cara de segredo (`.env`, chaves,
`.ssh`, nomes com senha/token).
- Visualiza na tela: imagens, PDF, vídeo, HTML (quadro isolado), texto (`md` formatado, `txt`, `csv`, `log`, `sql`,
  `json`, `yaml`, `xml`, `toml`, `ini` e código comum). `.sh` fica recusado de propósito.
- PowerPoint, Word, Excel e zip: só baixar (não há LibreOffice neste servidor).
- Tipos: `server/deliveries/files.ts` (`TYPES`); visualizador: `client/src/ui/deliveries.ts`.

## 8. Novo agente, projetos e chat

- "Novo agente": lista de projetos recentes sem a home e sem pastas inexistentes (`server/spawn/folders.ts`;
  `HABBLAUD_HIDDEN_FOLDERS` esconde outras); caixa de pesquisa aparece com 5+ pastas.
- "+ Projeto novo": cria a pasta em `~/projetos` (`HABBLAUD_PROJECTS_DIR`), roda `git init -b main` e abre a primeira
  sessão com a ideia (`server/spawn/project.ts`, `client/src/ui/spawn.ts`).
- Perguntas do agente (AskUserQuestion) viram cartão com opções e a resposta no chat, inclusive com várias perguntas
  (`client/src/ui/termtools.ts`, `termask.ts`).
- Nome e logotipo "Tower Tansyx": `client/src/ui/icons.ts` (`WORDMARK_GLYPHS`).

## 9. Backlog e pendências

Veja o fim de `DIARIO-DO-PROJETO.md` ("Em aberto").
