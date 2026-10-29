# Habblaud no PVE — resumo do trabalho

Documento de contexto: o que foi feito, por quê, e como operar. Serve para retomar o assunto em outra
sessão sem reconstruir o raciocínio.

Repositório: `tansyxtech/Tower-Tansyx` · upstream: [marmottajr/habblaud](https://github.com/marmottajr/habblaud) v1.0.3
(`faa1a012b5fb`)

Última atualização: 28/10/2026 (produção no commit `c6fdd63`; o trabalho de 27–28/10 está na seção 6c).

## 1. O que é o Habblaud

Escritório virtual em pixel art que mostra, em tempo real, o que os agentes do Claude Code estão fazendo:
cada projeto vira uma sala, cada agente um personagem.

Servidor Node sem dependências de runtime, porta **4747**. **Não tem API nem banco**: lê os arquivos que o
Claude Code já grava — `<conta>/projects/` (transcripts) e `<conta>/sessions/<pid>.json` (sessões abertas).

**Consequência que define tudo:** ele é um espelho da máquina onde roda. Agentes de outro computador nunca
aparecem, porque não há nada entrando pela rede.

## 2. O caminho até aqui

### Tentativa 1 — Coolify (abandonada)

Subiu e ficou saudável, mas o escritório ficava vazio: o servidor do Coolify não tinha sessões do Claude Code.
Pior, o **PTY é bloqueado dentro do Docker por código** (`server/index.ts:289`, `if (config.inDocker)`), e a
imagem não traz `node-pty` nem o executável `claude`.

A aplicação `Tower Tansyx` continua **parada** no Coolify Proxmox (não apagada), como rollback.
O `DEPLOY-COOLIFY.md` descreve esse caminho e está **superado**.

### Tentativa 2 — nativo no PVE (em produção)

O Habblaud roda direto no hypervisor Proxmox, fora de container.

> **Ressalva registrada:** o PVE é o hypervisor. Com o PTY ligado, o Basic Auth é a única coisa entre a
> internet e um shell root na máquina que controla todas as VMs. A opção mais segura — um LXC isolado —
> ficou para depois, por decisão consciente.

## 3. Arquitetura atual

```
navegador → Cloudflare → túnel towertansyx (cloudflared no host PVE)
          → Caddy :8080  (Basic Auth + reescrita de Host/Origin)
          → Habblaud 127.0.0.1:4747  [PTY ligado]
```

| Peça | Onde |
| --- | --- |
| Habblaud | `/root/habblaud`, serviço `habblaud.service` |
| Caddy | `/etc/caddy/Caddyfile`, porta 8080 |
| cloudflared | serviço no host, túnel `towertansyx` (`ee07ef56-…`) |
| Projetos | `/root/projetos/<repo>`: `DATAPULSE`, `hortifacil-pdv`, `resenha05`, `SIS_FINAC`, `SPP_CONTROL`, `TK3D`, `Tower-Tansyx` (todos em `tansyxtech`) |
| Terminais | tmux, servidor próprio `tmux -L habblaud` (sessões `habblaud-<id>`); ver 6c |
| Ajuste do serviço | `/etc/systemd/system/habblaud.service.d/hide-folders.conf` (`HABBLAUD_HIDE_FOLDERS=/root/habblaud`) |
| Contas | `/root/.claude` (Conta C) e `/root/.claude-socio` (Conta A) |
| GitHub no servidor | `gh` logado como `tansyxtech`, protocolo HTTPS; identidade global do git `tansyxtech <tansyxtech@gmail.com>` |

URL: `https://towertansyx.coffetech.com.br`

### As três travas que foram contornadas

O Habblaud bloqueia terminal e PTY fora de acesso local, de propósito — eles expõem a conversa inteira e
permitem executar código. Para funcionar pelo domínio, três proteções foram desligadas:

| Trava | Onde | Como foi contornada |
| --- | --- | --- |
| Bind local | `config.ts:159` | `HABBLAUD_HOST=127.0.0.1` + Caddy no meio |
| Host header | `guard.ts`, `isLoopbackHost` | `header_up Host localhost` |
| Origin = Host | `http/pty.ts:33` | `header_up Origin http://localhost` |

**O que sustenta a segurança hoje é só o Basic Auth do Caddy.** O Cloudflare Access seria melhor (bloqueia
antes de chegar ao servidor, independe de onde o Habblaud roda), mas exige assinar um plano do Zero Trust.

## 4. Operação

### Atualizar

```bash
cd /root/habblaud
git checkout -- package-lock.json
git pull --ff-only origin claude/adoring-goldberg-gnh2bj
npm install && npm run build
systemctl restart habblaud
```

Confira que pegou: `cat dist/build.json` tem que mostrar o commit novo. Depois, **Ctrl+Shift+R** no navegador.

Os terminais interativos rodam no tmux, então o `systemctl restart habblaud` **não derruba as conversas abertas**:
o log mostra "N terminal(is) continuam abertos de antes do reinício (tmux)". Isso vale só para terminais abertos
pelo Habblaud; uma sessão do Claude Code rodando fora do tmux do Habblaud (filha do próprio serviço) cai no restart.

Fluxo usado nos deploys de 27–28/10: commit no worktree → `git push origin HEAD:claude/adoring-goldberg-gnh2bj` →
`git -C /root/habblaud pull --ff-only` → `npm --prefix /root/habblaud run build` → `systemctl restart habblaud`.

### Conferir saúde

```bash
systemctl status habblaud --no-pager
journalctl -u habblaud -n 30 --no-pager
curl -s -H 'Host: localhost' http://127.0.0.1:4747/api/health
```

O `/api/health` deve trazer `"pty":true`, `"terminal":true`, `"demo":false`.

### Abrir sessões

```bash
tmux new -s trabalho
cd /root/projetos/<repo> && claude                              # Conta C
CLAUDE_CONFIG_DIR=/root/.claude-socio claude                    # Conta A
```

`Ctrl-B` depois `D` desanexa deixando rodando. **Só sessões abertas aparecem** no escritório.

Uma pasta só entra na lista do **Novo agente** depois que o `claude` rodou nela uma vez (aceitando a
confiança) — e isso vale **por conta**.

## 5. Armadilhas já pagas

| Sintoma | Causa |
| --- | --- |
| `404 page not found` | Rota faltando no túnel Zero Trust — era o `cloudflared` respondendo, não o Traefik (os dois são Go e dão o mesmo texto) |
| 404 mesmo com a rota criada | O CNAME continuava apontando para o túnel antigo; só resolveu apagando a rota antiga (que apaga o DNS junto) e recriando |
| `ERR_TOO_MANY_REDIRECTS` | Domínio configurado como `https://` no Coolify; com túnel tem de ser `http://` |
| `ERR_CONNECTION_TIMED_OUT` no `sslip.io` | O servidor não tem portas abertas: tudo entra pelo túnel. Testes por IP direto não servem |
| `origem não permitida para o terminal` | Faltava `header_up Origin http://localhost` no Caddy |
| **Restart não reiniciava nada** | `KillMode=process` mata só o processo principal, que com `ExecStart=npm start` era o **npm**, não o node. O node ficava órfão segurando a 4747 e todo restart falhava com "porta em uso". Corrigido com `ExecStart=/usr/bin/node dist/server/index.js` |
| Conversa vazia na janela ao vivo | Transcript movido para a pasta do worktree; o watcher ficava preso no caminho antigo. Corrigido em `26a7e55` — ver 6b |
| Sessões caíam a cada restart | O `claude` interativo era filho do node (PTY direto). Resolvido com o PTY dentro do tmux (6c); nunca reiniciar o serviço de dentro de uma sessão que não esteja no tmux do Habblaud |
| Personagens "root" aparecendo e sumindo | Eram os `claude -p /usage` do botão de uso, lidos como agentes; o watcher passou a ignorá-los |
| Pergunta respondida sumia do chat | O filtro "Sem ferramentas" escondia o `AskUserQuestion`; agora ele aparece em todos os filtros |
| `git`/sandbox recusa comandos compostos no worktree | Usar comandos simples e separados, ou scripts em arquivo no scratchpad |

A "Restart não reiniciava nada" custou horas de diagnóstico: o servidor antigo respondia a todos os testes, então
nenhuma mudança parecia fazer efeito.

## 6. Funcionalidades acrescentadas

Duas, em cima do upstream, no branch `claude/adoring-goldberg-gnh2bj`:

**`bc016a3` — escolher a conta no Novo agente.** O painel sempre começava na conta padrão. O servidor já
resolvia conta em `/api/pty`, mas `/api/spawn` não recebia o campo. Agora o painel mostra **Conta** acima de
**Projeto** quando há mais de uma.

**`c685d19` + `d196c60` — botão Retomar numa sessão encerrada.** O histórico era só leitura, e o "Assumir
daqui" exige agente vivo. O `d196c60` corrigiu o caso que importava: uma sessão que mudou de pasta no meio
(o agente cria um git worktree) retoma **no worktree**, porque o servidor lê o `cwd` da última linha do
transcript em vez de confiar no que o cliente manda.

**`26a7e55` — correção do transcript que muda de pasta.** Detalhada na seção 6b.

As três valem como contribuição para o upstream: as duas primeiras porque o autor deixou o servidor
meio-caminho pronto, e a terceira porque o teste demonstra o defeito.

### Limites conhecidos

- **Trocar a conta de uma sessão existente não é possível.** A conversa pertence à conta que a criou; não há
  suporte no Claude Code para migrar entre contas.
- No Docker, escolher a conta é recusado (quem executa é o auxiliar do host).
- Quando o pedido cai na tela do app do Claude, o link `claude://` não leva a conta — o painel avisa.

## 6b. Bug corrigido: conversa vazia na janela ao vivo

**Sintoma.** Clicar num agente abria o terminal com "Nenhuma mensagem nesta sessão ainda", embora o
escritório mostrasse a atividade normalmente e o histórico mostrasse a conversa inteira do mesmo arquivo.
Parecia intermitente; só um restart do Habblaud contornava.

**Causa.** O Claude Code leva o transcript para a pasta do worktree quando a sessão entra num
(`EnterWorktree`). O watcher resolvia o caminho **uma única vez** (`pumpMain`, só `if (!t.tail)`), então o
`FileTail` ficava preso no arquivo antigo, que já não existia. O `poll()` do terminal troca de arquivo, mas
só quando `transcriptPathOf` devolve caminho diferente — e ele devolve o caminho guardado, que nunca mudava.
Daí a aparência de intermitência: só quebrava quando o agente criava um worktree no meio da sessão.

**Correção (`26a7e55`).** Quando a leitura devolve `missing`, o watcher procura o transcript de novo pelo id
da sessão e troca o `FileTail`. O teste novo reproduz o cenário e falha sem a correção.

**Como foi encontrado.** Vale registrar o método, porque quatro hipóteses foram descartadas antes:

| Hipótese | Como caiu |
| --- | --- |
| Localização do arquivo | `resolveTranscript` varre todas as pastas de `projects/` pelo id |
| Chave do agente | `/api/snapshot` confirmou `.claude:<pid>`, o mesmo id que a interface usa |
| Parser | `GET /api/sessions/:conta/:id/terminal` renderizou a conversa inteira do mesmo arquivo |
| Filtro da interface | Trocar para "Tudo" não mudou nada |

O que fechou foi um **build instrumentado**, logando caminho resolvido, offset e número de entradas: deu
`entradas=0` antes do restart e `entradas=95` depois, com o mesmo caminho e o mesmo parser. Isso isolou o
cache velho de todo o resto.

Lição que vale para o próximo: num sintoma intermitente, comparar a rota ao vivo com a do histórico (mesmo
arquivo, mesmo parser) separa dados de estado em memória mais rápido do que ler código.

## 6c. Trabalho de 27–28/10/2026

Tudo isto está em produção e no `CHANGELOG.md` ("Não lançado"). Texto visível passa por `tr()` com tradução em
`shared/locales/` (`npm run i18n:check`). Nada em `shared/world/` nem `server/world/` foi tocado.

**Terminal e chat**

| O que | Resumo |
| --- | --- |
| Anexos | Imagem, PDF ou arquivo em sessão em andamento, no terminal interativo (`POST /api/pty/:id/attach`) e no chat (`POST /api/messages/attachments`; clipe, colar e soltar). O caminho vai no texto como `Anexo: <caminho>` (um texto começando com `/` seria recusado pelo plugin como comando) |
| "Assumir daqui" em sessões `bg` | A checagem do processo agora compara os ticks de início do kernel (`server/pty/procinfo.ts`), em vez da janela de 2 min |
| Chat ↔ terminal | Botão para alternar; o terminal **abre no chat por padrão**. `TerminalWindows` (`client/src/ui/termwindows.ts`) |
| Várias janelas | Até 4 terminais ao mesmo tempo (`MAX_WINDOWS`); clicar noutra sessão não sobrepõe mais |
| Perguntas e permissões no chat | O cartão de "Precisa de você" aparece e responde no chat; "Responder no terminal" vira aviso persistente com botão para abrir o terminal |
| Pergunta respondida | A pergunta do agente (`AskUserQuestion`) virou um cartão: pergunta, opções, "Você respondeu" com a opção escolhida. Aparece em todos os filtros (inclusive "Sem ferramentas") — `client/src/ui/termask.ts` |
| Sugestão de próximo prompt | A sugestão cinza do Claude Code aparece acima da caixa do chat; **Tab** aceita. O Claude Code não grava isso em arquivo, então o servidor lê a tela do tmux (`GET /api/pty/:id/suggestion`, `server/pty/suggestion.ts`). Só em terminal do Habblaud no tmux e com o agente ocioso |

**Sessões que sobrevivem a restart (tmux).** Antes, cada `claude` interativo era filho do node: todo restart ou crash
matava as conversas. Agora o PTY anexa um cliente a uma sessão do tmux (`server/pty/tmux.ts`, `manager.ts`); ao subir,
`adopt()` reconhece as sessões `habblaud-*` e anexa de novo (metadados no `@hb_meta`). "Encerrar" faz `kill-session`.
`KillMode=process` no systemd. Variáveis: `HABBLAUD_PTY_TMUX`, `HABBLAUD_TMUX_MOUSE` (README). Provado em e2e real e
em produção com vários restarts sem derrubar as sessões.

**Contas e uso**

- **Botão de atualizar o uso** das contas (`POST /api/usage/refresh`, `server/accounts/usage-refresh.ts`): roda
  `claude -p "/usage" --no-session-persistence`, que atualiza o `cachedUsageUtilization` do `.claude.json` sem gastar
  tokens. Esses `claude -p` apareciam como agentes "root" que surgiam e sumiam; agora o watcher os ignora
  (`ignorePid`/`owns`).
- **Escolher a conta em "Nova sessão" da sala**, para ter dois agentes na mesma sala com contas diferentes
  (`client/src/ui/newsession.ts`, menu `accountMenu` na gaveta).

**Lista de projetos do "Novo agente"** (`server/spawn/folders.ts`, `server/index.ts`)

- Pastas que não existem mais no disco deixam de ser sugeridas (o histórico de sessões as mantinha). Só fora do
  Docker, onde os caminhos são os do próprio computador.
- A pasta pessoal (`~`, `/root`) não é sugerida como projeto.
- `HABBLAUD_HIDE_FOLDERS` (separado por `:`) esconde outras pastas. Hoje vale `/root/habblaud` (a cópia de produção,
  que é um checkout real e por isso não dá para distinguir por regra) pelo ajuste do serviço citado na seção 3. Para
  mudar: editar o `hide-folders.conf`, `systemctl daemon-reload`, `systemctl restart habblaud`.
- Caixa de **pesquisa** acima da lista (a partir de 5 pastas): filtra por nome ou caminho, sem diferenciar
  maiúsculas nem acentos; Enter escolhe o primeiro, Esc limpa.

**Acesso**

- Senhas do Basic Auth no Caddy: usuários `Tiago`, `ansysar` e `luciano` (só os hashes ficam no Caddyfile). Todos
  entram no mesmo terminal com shell root; acesso restrito exigiria PTY só para o dono (os outros em leitura) ou o LXC
  isolado.

**Conta do GitHub trocada (28/10).** Os repositórios foram transferidos de `Tiagosilvag` para `tansyxtech`. No
servidor: `gh auth login` com a conta nova e logout da antiga, `user.name`/`user.email` globais, `origin` de cada
projeto trocado para `https://github.com/tansyxtech/<repo>.git` e o endereço antigo nos documentos. As chaves SSH
(`id_ed25519`, `id_rsa`) não estão cadastradas em nenhuma conta (`ssh -T git@github.com` dá `Permission denied`); o
servidor usa só HTTPS com o token do `gh`. Projetos que não serão mais usados (`GAPTECH`, `TOT`, `IA-BARBER-AGENDA`)
foram apagados do servidor; os repositórios originais continuam nas contas de origem.

**Não testado no navegador real.** Estas mudanças foram validadas por typecheck, `i18n:check`, vitest, build e e2e do
servidor; o aspecto visual foi conferido só nos prints do usuário.

### Login e usuários (código pronto, troca pendente)

O código está pronto no repositório, na branch `worktree-anexos-pty` (commits de `feat(users)` a `feat(ui): chip do
usuário…`), **ainda não implantado em produção**. O Caddy **continua** na frente (`:8080`) e a produção segue com o
Basic Auth; nada disto está ligado lá.

- **Arquitetura:** contas num SQLite (`node:sqlite`, `HABBLAUD_DB`, padrão `<dataDir>/habblaud.db`, modo 600) com
  hashes scrypt (`server/db/`, `server/users/`); a porta remota 4748 confere o login com `HABBLAUD_REMOTE_USERS=1`,
  com freio de 5 erros/15 min por usuário e sessão de 30 dias; `HABBLAUD_REMOTE_FULL=1` faz a sessão logada valer como
  o próprio computador (terminal, agentes, Novo agente), sem abrir hooks, plugins, Codex, auxiliar do host nem o
  Habblaud World; CLI `npm run users:add|passwd|list` e tela **Usuários** no chip do usuário. Detalhes no README
  ("Acesso por usuários").
- **Troca (NÃO feita, depende do dono):** (1) criar os usuários com `npm run users:add`; (2) ajuste do serviço
  `/etc/systemd/system/habblaud.service.d/remote-users.conf` com `HABBLAUD_REMOTE_USERS=1`, `HABBLAUD_REMOTE_FULL=1`,
  `HABBLAUD_REMOTE_INSECURE_HTTP=1`, `HABBLAUD_REMOTE_HOST=127.0.0.1` e `HABBLAUD_REMOTE_ALLOW`, mais `daemon-reload` e
  `restart`; (3) apontar o serviço do túnel `towertansyx` de `http://localhost:8080` para `http://localhost:4748`;
  (4) só depois de todos entrarem, desligar o Caddy. Volta: apontar o túnel de novo para `8080`.
- **Aviso:** com `HABBLAUD_REMOTE_FULL=1`, o login é a única barreira de um shell root.
- Spec: `docs/superpowers/specs/2026-10-28-login-usuarios-design.md`; plano:
  `docs/superpowers/plans/2026-10-28-login-usuarios.md`.

## 7. Pendências

1. **Trocar a senha do Caddy** (`caddy hash-password` → editar o Caddyfile → `systemctl reload caddy`). A
   atual circulou em conversa.
2. **Rotacionar o token do túnel** (Zero Trust → Tunnels → `towertansyx` → Configure → Refresh token) e
   reinstalar o serviço. Também circulou.
3. **Cloudflare Access** no lugar do Basic Auth, quando puderem assinar o Zero Trust.
4. **Migrar para um LXC isolado**, tirando o PTY de cima do hypervisor.
5. **Mandar as funcionalidades e a correção como PR** para o upstream (ver 6, 6b e 6c).
6. `DEPLOY-COOLIFY.md` está superado — vale marcar ou remover.
7. **Revogar o token OAuth antigo do `gh`** em GitHub (conta `Tiagosilvag`) → Settings → Applications: o logout no
   servidor só apagou a cópia local. Conferir também, na conta antiga, se há chave `root@pve` em SSH keys e, nos
   repositórios que o Coolify usava, deploy keys.
8. Testar no navegador real as mudanças de 6c (só foram validadas por testes e pelos prints do usuário).

## 8. Documentos relacionados

| Arquivo | Conteúdo |
| --- | --- |
| `PLANO-PTY-ACCESS.md` | O plano da migração, fase a fase, com rollback |
| `DEPLOY-COOLIFY.md` | O caminho do Coolify (**superado**) |
| `coolify/docker-compose.coolify.yml` | Compose para o Coolify (**superado**) |
| `README.pt-BR.md` | Documentação do upstream |
