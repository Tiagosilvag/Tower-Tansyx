# Plano: Habblaud nativo com PTY, protegido por Cloudflare Access

Objetivo: o servidor se comporta como o PC de vocês — as contas do Claude Code ficam nele, as
sessões rodam nele, e vocês acessam tudo (escritório, terminal, PTY) pelo link
`https://towertansyx.coffetech.com.br`, atrás de uma tela de login da Cloudflare.

## Por que a arquitetura muda

O PTY (terminal interativo: assumir sessão, Novo agente, encerrar) é bloqueado **dentro do Docker**
por código, não por configuração — `server/index.ts:289`:

```js
else if (config.inDocker) ptyOff = tr('indisponível no Docker (rode com npm start)');
```

Além disso, a imagem do Docker não traz o `node-pty` (é `optionalDependency`, e o Dockerfile copia
só `package.json` e `dist/`) nem o executável `claude`. Por isso o Habblaud sai do container.

| Hoje | Depois |
| --- | --- |
| Container no Coolify | `npm start` nativo, em serviço systemd |
| Túnel → `coolify-proxy:80` | Túnel → `http://localhost:4747` |
| `cloudflared` em container | `cloudflared` no host (um container não alcança o loopback do host) |
| Sem autenticação | Cloudflare Access na frente |

### As duas travas, e como são satisfeitas

O Habblaud só liga terminal/PTY quando se considera acessado localmente. São duas checagens
independentes, em `server/config.ts` e `server/http/guard.ts`:

1. **Bind local** (`config.ts:159`): fora do Docker basta `isLoopbackBind(host)` → `HABBLAUD_HOST=127.0.0.1`.
2. **Host header local** (`guard.ts`, `isLoopbackHost`): cada requisição precisa chegar com
   `Host: localhost`. Resolve-se com o **HTTP Host Header** do Cloudflare Tunnel.

O POST não quebra por CSRF: `originAllowed()` aceita a Origin cujo nome esteja em
`HABBLAUD_ALLOWED_HOSTS` — por isso o domínio real continua nessa variável.

> **Isto desliga de propósito uma proteção dos autores.** Com `Host: localhost`, o servidor passa a
> tratar todo visitante como local: a conversa inteira das sessões fica legível e, com PTY, quem
> abrir a URL digita no Claude Code do servidor. **O Cloudflare Access não é opcional neste plano.**

## Fase 0 — Proteger primeiro (fazer agora)

Hoje o link está aberto a quem o descobrir. Faça isto antes de qualquer outra fase.

1. **Zero Trust → Access → Applications → Add an application → Self-hosted**
2. Nome `Habblaud`; defina a *Session Duration*
3. **Public hostname:** `towertansyx.coffetech.com.br`
4. **Add policy:** Action `Allow` · Include → **Emails** → os e-mails de vocês dois
5. Salvar e testar numa janela anônima: deve aparecer a tela de login da Cloudflare

A política fica presa ao hostname, então continua valendo depois da migração.

## Fase 1 — Preparar o servidor

Rode como o **mesmo usuário** que vai ser dono das sessões do Claude Code (no seu caso, `root`), já
que o Habblaud vai ler `~/.claude` e executar o `claude`.

```bash
# Node 22.12+ e ferramentas de build (o node-pty é módulo nativo)
node --version
apt-get install -y build-essential python3 git

# Claude Code
npm i -g @anthropic-ai/claude-code
claude --version
which claude            # anote o caminho absoluto

# Habblaud
git clone https://github.com/Tiagosilvag/Tower-Tansyx.git ~/habblaud
cd ~/habblaud && npm install && npm run build
```

Faça o login das contas do Claude Code agora (`claude`, e repita com
`CLAUDE_CONFIG_DIR=~/.claude-conta2 claude` para a segunda conta, se houver).

Confirme que o `node-pty` compilou — sem ele o PTY não liga:

```bash
node -e "require('node-pty'); console.log('node-pty ok')"
```

## Fase 2 — Serviço systemd

`/etc/systemd/system/habblaud.service`:

```ini
[Unit]
Description=Habblaud
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/habblaud
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5

Environment=NODE_ENV=production
Environment=HABBLAUD_HOST=127.0.0.1
Environment=HABBLAUD_PORT=4747
Environment=HABBLAUD_PTY=1
Environment=HABBLAUD_ALLOWED_HOSTS=towertansyx.coffetech.com.br
Environment=HABBLAUD_LANG=pt-BR
Environment=HABBLAUD_UPDATE_CHECK=0
Environment=HABBLAUD_WORLD=0
# O systemd usa um PATH mínimo: aponte o executável do Claude Code pelo caminho absoluto
# (o que `which claude` devolveu na Fase 1).
Environment=HABBLAUD_CLAUDE_BIN=/usr/local/bin/claude

[Install]
WantedBy=multi-user.target
```

**Não** defina `HABBLAUD_IN_DOCKER`, **não** defina `HABBLAUD_TERMINAL=0` e **não** defina
`HABBLAUD_DEMO` — qualquer um dos três derruba o que queremos.

```bash
systemctl daemon-reload && systemctl enable --now habblaud
journalctl -u habblaud -f
```

Os logs do arranque dizem, linha a linha, o que ficou ligado. O alvo é ver o terminal e o
**Novo agente** ligados, sem a frase `indisponível no Docker`.

```bash
curl -s -H 'Host: localhost' http://127.0.0.1:4747/api/health
```

## Fase 3 — `cloudflared` no host

O conector precisa rodar **no host**, não em container: o Habblaud escuta no loopback, que um
container não enxerga.

Vocês já criaram o túnel `towertansyx` (ID `ee07ef56-…`), que está inativo. Use esse.

1. Zero Trust → Networks → Tunnels → `towertansyx` → instruções de instalação, **Debian/64-bit**
2. Rode no servidor o comando `cloudflared service install <token>`
3. Confirme que o túnel aparece **Healthy**
4. **Public Hostname:**
   - Subdomain `towertansyx` · Domain `coffetech.com.br` · Path vazio
   - **Service:** `http://localhost:4747`
   - **Additional application settings → HTTP Settings → HTTP Host Header:** `localhost`

O Host Header é a peça central: sem ele, terminal, PTY, mensagens e permissões ficam desligados.

## Fase 4 — Trocar a rota

Dois túneis não podem reivindicar o mesmo hostname.

1. No `coolifyprod-tunnel`, **remova** a rota `towertansyx.coffetech.com.br`
2. Confirme que o registro DNS aponta para o túnel novo (o Zero Trust acerta sozinho ao salvar)
3. **Pare** a aplicação no Coolify — não apague ainda, é o seu rollback

## Fase 5 — Validar

Em janela anônima, abra `https://towertansyx.coffetech.com.br`:

- [ ] Cai na tela de login da Cloudflare
- [ ] Depois de autenticar, o escritório abre
- [ ] As contas do Claude Code aparecem no topo (não "Demonstração")
- [ ] Uma sessão aberta no servidor vira personagem
- [ ] Tecla `T` abre o terminal com a conversa
- [ ] **Abrir terminal** aceita digitação (PTY)
- [ ] **Novo agente** cria uma sessão
- [ ] Tecla `P` aprova uma permissão

Lembre: **só aparecem sessões abertas**. Para testar, deixe um `claude` rodando (use `tmux` para a
sessão sobreviver ao fechar o SSH).

## Fase 6 — Opcional

- `npm run mod:install` — liga os percentuais de uso de 5h e semanal, e a linha "precisa de você"
- `npm run mod:status` — confere

## Rollback

1. Reative a rota `towertansyx` no `coolifyprod-tunnel` (Service `http://coolify-proxy:80`, sem Host Header)
2. Remova a rota do túnel `towertansyx` e pare o conector
3. `systemctl stop habblaud`
4. Inicie a aplicação no Coolify

## Armadilhas conhecidas

| Sintoma | Causa provável |
| --- | --- |
| PTY desligado nos logs | `HABBLAUD_CLAUDE_BIN` errado, ou `node-pty` não compilou |
| Terminal desligado | `HABBLAUD_HOST` não é loopback, ou `HABBLAUD_TERMINAL=0` ficou para trás |
| 403 "Host não permitido" | Falta o **HTTP Host Header = localhost** na rota do túnel |
| 403 "Origem não permitida" | O domínio saiu do `HABBLAUD_ALLOWED_HOSTS` |
| 404 do `cloudflared` | A rota ficou em dois túneis, ou em nenhum |
| Escritório vazio | Nenhuma sessão **aberta** no servidor |

## O que se perde na migração

- A linha do tempo do timelapse gravada no volume `/data` do Docker não é levada; o modo nativo
  passa a gravar em `~/.habblaud`. Se quiser preservar, copie o conteúdo do volume antes.
- O build e o deploy deixam de ser pelo Coolify: atualizar passa a ser
  `git pull && npm install && npm run build && systemctl restart habblaud`.
