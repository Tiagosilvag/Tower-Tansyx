# Habblaud no PVE — resumo do trabalho

Documento de contexto: o que foi feito, por quê, e como operar. Serve para retomar o assunto em outra
sessão sem reconstruir o raciocínio.

Repositório: `Tiagosilvag/Tower-Tansyx` · upstream: [marmottajr/habblaud](https://github.com/marmottajr/habblaud) v1.0.3
(`faa1a012b5fb`)

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
| Projetos | `/root/projetos/<repo>` (10 repositórios clonados) |
| Contas | `/root/.claude` (Conta C) e `/root/.claude-socio` (Conta A) |

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

A última custou horas de diagnóstico: o servidor antigo respondia a todos os testes, então nenhuma mudança
parecia fazer efeito.

## 6. Funcionalidades acrescentadas

Duas, em cima do upstream, no branch `claude/adoring-goldberg-gnh2bj`:

**`bc016a3` — escolher a conta no Novo agente.** O painel sempre começava na conta padrão. O servidor já
resolvia conta em `/api/pty`, mas `/api/spawn` não recebia o campo. Agora o painel mostra **Conta** acima de
**Projeto** quando há mais de uma.

**`c685d19` + `d196c60` — botão Retomar numa sessão encerrada.** O histórico era só leitura, e o "Assumir
daqui" exige agente vivo. O `d196c60` corrigiu o caso que importava: uma sessão que mudou de pasta no meio
(o agente cria um git worktree) retoma **no worktree**, porque o servidor lê o `cwd` da última linha do
transcript em vez de confiar no que o cliente manda.

Ambas valem como contribuição para o upstream — o autor deixou o servidor meio-caminho pronto nos dois casos.

### Limites conhecidos

- **Trocar a conta de uma sessão existente não é possível.** A conversa pertence à conta que a criou; não há
  suporte no Claude Code para migrar entre contas.
- No Docker, escolher a conta é recusado (quem executa é o auxiliar do host).
- Quando o pedido cai na tela do app do Claude, o link `claude://` não leva a conta — o painel avisa.

## 7. Pendências

1. **Trocar a senha do Caddy** (`caddy hash-password` → editar o Caddyfile → `systemctl reload caddy`). A
   atual circulou em conversa.
2. **Rotacionar o token do túnel** (Zero Trust → Tunnels → `towertansyx` → Configure → Refresh token) e
   reinstalar o serviço. Também circulou.
3. **Cloudflare Access** no lugar do Basic Auth, quando puderem assinar o Zero Trust.
4. **Migrar para um LXC isolado**, tirando o PTY de cima do hypervisor.
5. **Mandar as duas funcionalidades como PR** para o upstream.
6. `DEPLOY-COOLIFY.md` está superado — vale marcar ou remover.

## 8. Documentos relacionados

| Arquivo | Conteúdo |
| --- | --- |
| `PLANO-PTY-ACCESS.md` | O plano da migração, fase a fase, com rollback |
| `DEPLOY-COOLIFY.md` | O caminho do Coolify (**superado**) |
| `coolify/docker-compose.coolify.yml` | Compose para o Coolify (**superado**) |
| `README.pt-BR.md` | Documentação do upstream |
