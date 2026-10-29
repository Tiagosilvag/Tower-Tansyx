# Diário do projeto — Tower Tansyx

Registro cronológico do que foi pedido, decidido e feito. Mais recente primeiro dentro de cada dia. O conhecimento de
como as coisas funcionam está em [`KI.md`](KI.md).

> **Regra:** a cada pedido atendido (implementação ou mudança), acrescente aqui uma entrada com: o que foi pedido, o que
> foi feito, commits, se foi para produção e o que ficou em aberto. Atualize também o `KI.md` quando o conhecimento mudar.
> Sem segredos.

Formato: `### AAAA-MM-DD — título` · **Pedido** · **Feito** · **Commits** · **Produção** · **Em aberto**.

---

## 2026-10-29

### Chat: carregar a conversa anterior
- **Pedido:** "Por que no chat ele não está carregando as conversas anteriores?" (print desta sessão com "Conversa anterior
  não carregada").
- **Causa:** o chat só lê o fim do transcript (4 MB / 500 entradas); esta sessão tem ~37 MB.
- **Feito:** botão "Carregar conversa anterior" (+500 entradas por clique) para agentes e sessões do histórico; ver KI §5a.
  Testes: `server/sources/earlier.test.ts`, rota em `server/http/terminal.test.ts`, `TerminalLog.prepend` em `terminal.test.ts`.
- **Limite:** o transcript guarda também o que o Claude já resumiu na compactação, então dá para ver o que veio antes dela.
- **Produção:** pendente de deploy.

### Kanban: coluna Revisão e padrão de comentário
- **Pedido:** adicionar uma etapa de revisão no quadro; ao mover um cartão para ela, comentar o porquê; instruir os agentes no
  CLAUDE.md das contas.
- **Feito:** coluna `revisao` entre Fazendo e Feito (5 colunas, cor amarela); `tower-kanban move ... revisao` exige
  `--comment` e grava o comentário junto; instruções atualizadas em `/root/.claude/CLAUDE.md`, `/root/.claude-socio/CLAUDE.md`
  e `docs/kanban-agentes.md`.
- **Decisões minhas:** a regra é aplicada no comando dos agentes (e pelas instruções), não na página: quem arrasta um cartão
  para Revisão na tela não é obrigado a comentar. Cartões antigos ficam onde estão.
- **Em aberto:** sessões de agente já abertas só leem o CLAUDE.md novo ao reiniciar.
- **Produção:** no ar desde `c3155f0`.

### Chat: mostrar "Compactando a conversa…"
- **Pedido:** durante a compactação o chat ficava só em "Pensando…" (prints do chat e do terminal interativo).
- **Causa:** o Claude Code não escreve nada no transcript durante a compactação; só a tela do terminal mostra
  "Compacting conversation…".
- **Feito:** `CompactionWatch` no servidor lê a saída do pty e marca `PtyInfo.compacting`; rodapé e aba do chat mostram
  "Compactando a conversa…". Testes em `server/pty/compaction.test.ts` e `terminal.test.ts`.
- **Limite:** só sessões com pty do Habblaud; outras seguem em "Pensando…". A frase é a do Claude Code em inglês: se a versão
  mudar o texto, ajustar `PHRASE`.
- **Produção:** no ar desde `526d53b`.

### Kanban: colar print com Ctrl+V no cartão
- **Pedido:** "quero poder dar CTRL+V e colar um print, igual faço aqui no chat".
- **Feito:** o cartão aberto trata o evento de colar: imagem ou arquivos na área de transferência viram anexo (print ganha o
  nome `print-AAAA-MM-DD-HHMMSS.png`); texto colado continua normal nos campos. `pastedFileName` em `kanban-model.ts`, testado.
- **Produção:** no ar desde `526d53b`.

### Kanban: anexar arquivos nos cartões
- **Pedido:** "quero poder anexar arquivos nos cards do kanban".
- **Feito (defaults que escolhi, ver KI §6):** até 20 arquivos de 15 MB por cartão; botão e arrastar; lista com miniatura das
  imagens, tamanho, quem enviou; Remover; "N anexos" no cartão do quadro; histórico registra anexou/removeu. Imagem, PDF e
  texto abrem na tela, o resto só baixa. Disco: `kanban-files/<cartão>/<id>`; apagar o cartão apaga a pasta.
- **Em aberto:** o `tower-kanban` (agentes) não anexa arquivos; não há limite do total em disco.
- **Produção:** no ar desde `8108042`.

### Agentes de qualquer projeto enxergam o Kanban
- **Pedido:** o luciano perguntou "no Kanban do Tower Tansyx?" a um agente de outro projeto, e ele respondeu que não tinha
  acesso (print). O pedido original era que os agentes conseguissem ver o Kanban.
- **Causa:** o comando `npm run kanban` só funciona na pasta do Habblaud e o bloco de instruções nunca foi instalado nos
  `CLAUDE.md` dos agentes.
- **Feito:** script `scripts/tower-kanban` (funciona de qualquer pasta) ligado em `/usr/local/bin/tower-kanban`; o bloco de
  instruções foi gravado em `/root/.claude/CLAUDE.md` e `/root/.claude-socio/CLAUDE.md` (CLAUDE.md do usuário de cada conta).
  `docs/kanban-agentes.md` ganhou a instalação. Só valem para sessões novas: as abertas não releem o arquivo.
- **Em aberto:** conta nova do Claude Code precisa do mesmo bloco no `CLAUDE.md` dela.
- **Commits:** `35a511b`. **Produção:** o script já está no `/root/habblaud` (pull); não precisa reiniciar.

### Kanban: responsável visível no cartão
- **Pedido:** "No card também traga quem é o responsável por aquela task" (print de um cartão sem responsável).
- **Feito:** avatar na cor da pessoa + nome de exibição no cartão (ou "Sem responsável"); cartão novo nasce com quem o criou
  como responsável (ruling: assumi isso por ser o padrão mais útil; `assigneeId: null` deixa sem). Cartões antigos intactos.
- **Produção:** no ar desde `2b23904`.

### Kanban: atualizar sozinho e botão Atualizar
- **Pedido:** o Kanban só mostrava o que um colega mexeu depois de fechar e abrir; criar um botão de atualizar ou atualizar
  sempre que houver ação.
- **Feito:** os dois. Revisão no servidor (`/api/kanban/version`), consulta a cada 3 s com a janela aberta, botão ↻ na barra
  e proteção contra recarregar no meio de uma digitação ou arrasto. Teste da revisão em `server/kanban/http.test.ts`.
- **Produção:** no ar desde `a250f9d`.

### Barra lateral: pílulas com o nome (opção A)
- **Pedido:** destacar mais que há alguém com o agente; entre 4 exemplos, "gostei da A".
- **Feito:** a linha do agente mostra uma pílula por pessoa (avatar + nome, na cor dela; "nome digitando…" quando digita),
  no máximo 2 e "+N", abaixo da linha do nome. Mockup: artifact "Presença na lateral".
- **Produção:** no ar desde `a250f9d`.

### Correção: "digitando" não aparecia
- **Pedido:** o luciano digitava no chat da Larissa e o tiago não via. O `/api/presence` mostrava o luciano com o agente
  aberto, mas `typing:false`.
- **Causa:** o aviso extra ao digitar respeitava um intervalo de 2,5 s e era descartado quando caía logo depois de um aviso;
  uma digitada curta só seria enviada no aviso seguinte (até 8 s), quando o "digitando" local (4 s) já tinha vencido.
- **Feito:** o aviso passa a ser agendado para quando o intervalo passar; a consulta vai de 4 s para 2,5 s.
- **Produção:** no ar desde `d685fe0`.

### Avatares da presença na barra lateral
- **Pedido:** "Fazer os avatares na barra lateral também".
- **Feito:** `paintPresenceFaces` em `client/src/ui/presence.ts`, usado em `rows.ts` (linha do agente na barra lateral e na
  gaveta); o rosto balança quando a pessoa digita e o texto vai no tooltip. A tela só se redesenha quando a lista muda.
- **Produção:** pendente de deploy.

### Presença em tempo real
- **Pedido:** "pode começar" (avatares de quem está com a sessão aberta e "está digitando…", propostos depois da pergunta
  sobre colaboração entre sócios).
- **Feito:** `Presence` (memória) + rotas `/api/presence` + `startPresence`/`presenceStrip` no cliente, nas barras do
  chat e do terminal interativo; textos em en/es/fr; testes do servidor, da rota e do modelo. Detalhes no `KI.md` §5.
- **Commits:** ver o log da branch (feat(presença)). **Produção:** no ar desde `4e36ea9`.
- **Em aberto:** não há trava de "um escreve por vez".

### Diário do projeto e KI
- **Pedido:** criar o diário de projeto e o KI (knowledge) e mantê-los atualizados a cada mudança, para um colaborador
  poder assumir o projeto sem se perder.
- **Feito:** criados `DIARIO-DO-PROJETO.md` e `KI.md`; regra de manutenção registrada no `CLAUDE.md`.
- **Produção:** são documentos, vão junto com o próximo deploy.

### Teto de tentativas por nome (segurança do login)
- **Pedido:** corrigir o bloqueio que a revisão final apontou antes de aposentar o Caddy.
- **Feito:** em `server/users/auth.ts`, a limpeza de memória (`pushWindow`) agora protege as janelas já acima do teto de
  100 erros/h: inundar o mapa com nomes aleatórios não esvazia mais o freio de um nome atacado. Teste `(c2)` em
  `server/users/auth.test.ts` (falha sem a correção).
- **Commits:** na branch `claude/adoring-goldberg-gnh2bj` até `510f763`.
- **Produção:** no ar desde `4e36ea9` (deploy de 2026-10-29).

### Arquivos nas Entregas
- **Pedido:** visualizar na tela textos, HTML, sql, md, txt; PowerPoint só para baixar; fazer só "abrir sql/código como
  texto" e "md formatado".
- **Feito:** `.sql`, `.json`, `.yaml/.yml`, `.xml`, `.toml`, `.ini`, js/ts/tsx/jsx/py/css/rb/go/java/rs/php abrem como
  texto; `.md` aparece formatado; links para esses arquivos na resposta viram anexos. `.sh` continua recusado.
- **Commits:** `386528f`. **Produção:** no ar desde `4e36ea9`.

### Marcação de quem escreveu cada mensagem
- **Pedido:** diferenciar a mensagem do usuário da resposta, com degradê leve na cor do usuário; mockup aprovado.
- **Feito:** tabela `message_senders`, `SenderLog`, `TypedLines`, `annotate` no stream do terminal, estilo `has-by` no
  chat. O Claude não recebe o nome. Detalhes no `KI.md` §5.
- **Commits:** `8d87eb8`. **Produção:** no ar.

### Senha mínima de 8 caracteres
- **Pedido:** poder usar senha de 8 ou mais caracteres.
- **Feito:** `MIN_PASSWORD` de 10 para 8 (tela, API, `users:add`); READMEs, CHANGELOG e testes ajustados. `remote:setup` mantém 10.
- **Commits:** `72abb0b`. **Produção:** no ar.

### Merge do login com usuários e do Kanban na branch de produção
- **Pedido:** "pode fazer o deploy e o merge".
- **Feito:** a branch `worktree-anexos-pty` foi levada (avanço simples) para `claude/adoring-goldberg-gnh2bj`; deploy com
  `pull --ff-only`, build e reinício. O modo de usuários já estava ligado no serviço (3 usuários, acesso total).
- **Produção:** no ar em `72abb0b`, depois `8d87eb8`.

### Perguntas respondidas (sem código)
- Presença em tempo real (quem está usando a sessão): **não existe**; proposta de avatares por sessão + "está digitando"
  (ver Em aberto).
- Usuários cadastrados: `tiago`, `ansysar`, `luciano` (`npm run users:list`); senhas não são legíveis.

## 2026-10-28 e antes (resumo)

- **Conta do GitHub:** repositórios movidos para `tansyxtech`; remoto e documentos atualizados; pastas de projetos não
  usados apagadas (GAPTECH, TOT, IA-BARBER-AGENDA); SIS_FINAC transferido.
- **Novo agente:** lista sem GAPTECH, `/root` e `/root/habblaud`; caixa de pesquisa.
- **Chat:** cartão com a pergunta do agente e a resposta, para uma e várias perguntas.
- **Nome:** "Tower Tansyx" na aba, logotipo e notificações.
- **Projeto novo do zero:** pasta, `git init` e primeira sessão pelo painel.
- **Skills:** `superpowers` e `impeccable` instaladas no projeto e na sessão.
- **Kanban:** ideias e tarefas em SQLite (quadro Geral e por projeto).
- **Login e usuários:** design e plano em `docs/superpowers/specs/2026-10-28-login-usuarios-design.md` e
  `docs/superpowers/plans/2026-10-28-login-usuarios.md`; execução subagent-driven com revisão por tarefa e final.
- **Incidente de teste:** uma instância de teste herdou `HABBLAUD_PTY=1` e se anexou por segundos às sessões tmux de
  produção; verificado sem dano (ver armadilhas no `KI.md`).

---

## Em aberto

- **Presença:** falta ver no navegador (só testada por testes automáticos) e, se quiserem, uma trava opcional de
  "um escreve por vez".
- (Concluído) **Caddy** aposentado: serviço inativo e desabilitado; o acesso é só pelo login com usuários na 4748.
- Revogar o token OAuth antigo do `gh`.
- Conferir no navegador o visual das telas de login, usuários e da marcação no chat.
- `server/index.users.test.ts` nunca foi rodado.
- Outros Minors da revisão final do login estão no livro-razão local `.superpowers/sdd/2026-10-28-login-usuarios/`
  (ignorado pelo git).
