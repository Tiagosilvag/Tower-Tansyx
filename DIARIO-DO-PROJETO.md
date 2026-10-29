# Diário do projeto — Tower Tansyx

Registro cronológico do que foi pedido, decidido e feito. Mais recente primeiro dentro de cada dia. O conhecimento de
como as coisas funcionam está em [`KI.md`](KI.md).

> **Regra:** a cada pedido atendido (implementação ou mudança), acrescente aqui uma entrada com: o que foi pedido, o que
> foi feito, commits, se foi para produção e o que ficou em aberto. Atualize também o `KI.md` quando o conhecimento mudar.
> Sem segredos.

Formato: `### AAAA-MM-DD — título` · **Pedido** · **Feito** · **Commits** · **Produção** · **Em aberto**.

---

## 2026-10-29

### Correção: "digitando" não aparecia
- **Pedido:** o luciano digitava no chat da Larissa e o tiago não via. O `/api/presence` mostrava o luciano com o agente
  aberto, mas `typing:false`.
- **Causa:** o aviso extra ao digitar respeitava um intervalo de 2,5 s e era descartado quando caía logo depois de um aviso;
  uma digitada curta só seria enviada no aviso seguinte (até 8 s), quando o "digitando" local (4 s) já tinha vencido.
- **Feito:** o aviso passa a ser agendado para quando o intervalo passar; a consulta vai de 4 s para 2,5 s.
- **Produção:** pendente de deploy.

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
