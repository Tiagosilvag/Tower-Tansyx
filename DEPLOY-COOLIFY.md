# Habblaud no Coolify — análise e deploy

Importado de [marmottajr/habblaud](https://github.com/marmottajr/habblaud), tag `v1.0.3`
(commit `faa1a012b5fbf632c66dc6801c5383e53a542406`). O código original está intacto; o que foi
acrescentado é este ficheiro e `coolify/docker-compose.coolify.yml`.

## 1. O que o prompt do site manda fazer (e o que isso significa)

O prompt de habblaud.com é um **instalador para a tua máquina pessoal**, não para um servidor. Ele:

1. deteta o sistema (macOS / Linux / Windows+WSL2) e **quais agentes tu usas** (Claude Code, Codex);
2. instala `git`, Node 22.12+, Docker e atualiza o Claude Code / Codex;
3. faz `git clone` para `~/habblaud` e `npm install`;
4. corre `npm run docker:up` — este é o passo central: um script (`scripts/docker-up.ts`) que
   **procura as contas do Claude Code e as pastas do Codex no teu computador**, gera um
   `docker-compose.override.yml` com montagens **somente leitura** dessas pastas e só depois sobe o container;
5. `npm run mod:install` — instala o mod `habblaud` e os plugins `habblaud-permissoes` e
   `habblaud-mensagens` **dentro das tuas contas do Claude Code** (altera `settings.json`);
6. `npm run codex:install` — acrescenta hooks ao `hooks.json` do Codex, e exige um serviço
   permanente (`npm run codex:bridge`) a correr **no host**, em systemd/LaunchAgent;
7. `portless alias habblaud 4747` — para dar o endereço bonito `https://habblaud.localhost`.

## 2. Como a aplicação funciona

É um **escritório virtual em pixel art** que mostra em tempo real o que os agentes do Claude Code
(e do Codex) estão a fazer: cada projeto é uma sala, cada agente é um personagem.

- **Servidor:** Node 24 (Alpine), TypeScript, **zero dependências de runtime** (só módulos `node:*`).
  Cliente em Vite, compilado para `dist/`. Porta **4747**.
- **Fonte dos dados:** não há API nem base de dados. Ele **lê ficheiros que o Claude Code já escreve**:
  `<conta>/projects/` (transcripts) e `<conta>/sessions/` (sessões abertas e estado), mais
  `~/.habblaud/usage/` (percentagens de uso de 5 h e semanal, escritas pelo mod).
- **Estado próprio:** volume `/data` (nomes dos personagens, timelapse, estatísticas do "Meu dia").
- **Segurança do container:** utilizador sem privilégios, `read_only`, `cap_drop: ALL`,
  `no-new-privileges`, healthcheck em `/api/health`.

### Duas travas que decidem o deploy num servidor

Ambas estão no código (`server/http/guard.ts`, `server/http/terminal.ts`), não são configuráveis a gosto:

1. **Host header.** O servidor recusa com **403** qualquer pedido cujo `Host` não seja
   `localhost`, `*.localhost` ou um IP de loopback — proteção contra DNS rebinding. Para abrir por
   um domínio atrás do Traefik do Coolify, **tens de pôr esse domínio em `HABBLAUD_ALLOWED_HOSTS`**.
   Sem isso vês 403 e nada mais.
2. **Terminal e histórico só funcionam em acesso local.** No Docker, só ligam se `HABBLAUD_BIND`
   for um valor de loopback (`127.0.0.1`). Com a porta exposta à rede (ou com `HABBLAUD_BIND`
   ausente, que é o caso no Coolify) ficam **desligados** de propósito: mostram a conversa inteira
   das sessões. Nomes de `HABBLAUD_ALLOWED_HOSTS` são explicitamente recusados nessas rotas.

### A limitação principal

**Num servidor remoto o escritório aparece vazio.** O Habblaud não recebe dados por rede: ele lê os
ficheiros de sessão do Claude Code da máquina onde corre. O servidor do Coolify não tem as tuas
contas do Claude Code, e não há forma de o teu portátil "enviar" sessões para lá.

Três cenários reais:

| Cenário | Resultado |
| --- | --- |
| Deploy só no Coolify, sem montagens | Sobe e responde, mas **escritório vazio** (0 salas, 0 agentes). Serve para validar o deploy. |
| Deploy no Coolify com `HABBLAUD_DEMO=1` | Escritório **fictício** animado — bom para demonstração. |
| Deploy no Coolify + o **próprio servidor** corre Claude Code / Codex | Funciona a sério: montas `~/.claude/projects` e `~/.claude/sessions` do servidor (ver volumes comentados no compose). |

Se o objetivo é ver os agentes do **teu computador**, o sítio certo é o teu computador (como o prompt
diz). O Coolify faz sentido para demonstração, ou se for o servidor a hospedar as sessões dos agentes.

Também não vale a pena, no Coolify: `mod:install`, `codex:install`, `codex:bridge` e `portless` — são
todos passos de host, mexem nas pastas dos agentes e no login do sistema operativo.

## 3. Deploy no Coolify (servidor Proxmox, que já tem Docker)

### Opção A — build pack **Dockerfile** (mais simples, recomendada)

1. **New Resource → Application → Private/Public Repository**
   - Repositório: `https://github.com/Tiagosilvag/Tower-Tansyx`
   - Branch: `claude/adoring-goldberg-gnh2bj`
2. **Build Pack: `Dockerfile`** · Dockerfile Location: `/Dockerfile` · Base Directory: `/`
3. **Ports Exposes: `4747`**
4. **Domains:** o domínio que quiseres (ex.: `habblaud.exemplo.com`). O Coolify emite o certificado.
5. **Environment Variables:**
   ```
   HABBLAUD_ALLOWED_HOSTS=habblaud.exemplo.com
   HABBLAUD_LANG=pt-BR
   HABBLAUD_TERMINAL=0
   HABBLAUD_UPDATE_CHECK=0
   HABBLAUD_WORLD=0
   HABBLAUD_DEMO=1          # tira esta linha quando tiveres transcripts a montar
   ```
   O valor de `HABBLAUD_ALLOWED_HOSTS` **tem de ser exatamente** o domínio configurado no passo 4.
6. **Persistent Storage:** volume no caminho `/data` (senão perdes nomes e timelapse a cada deploy).
7. **Healthcheck** (opcional, o Dockerfile já traz um): path `/api/health`, porta `4747`.
8. **Deploy.** O build leva alguns minutos (compila cliente + servidor).

### Opção B — build pack **Docker Compose**

Usa `coolify/docker-compose.coolify.yml` (Base Directory `/`, Compose Location
`/coolify/docker-compose.coolify.yml`). Ele já traz o FQDN mágico `SERVICE_FQDN_HABBLAUD_4747`, o
volume `/data`, o endurecimento e os volumes de transcripts comentados. Define
`HABBLAUD_ALLOWED_HOSTS` nas variáveis da aplicação.

**Não uses** o `docker-compose.yml` da raiz no Coolify: ele publica a porta em `127.0.0.1` do host e
pressupõe o `docker-compose.override.yml` que só o `npm run docker:up` gera na tua máquina.

### Verificar

```
curl -H 'Host: habblaud.exemplo.com' https://habblaud.exemplo.com/api/health
```

- **200** com JSON → está a servir.
- **403** → o domínio não está em `HABBLAUD_ALLOWED_HOSTS` (ou está escrito de forma diferente).
- Terminal e histórico vão aparecer desligados: é o comportamento esperado atrás de proxy.

> Nota: sem autenticação, quem souber o domínio vê o escritório. O Habblaud só tem login no modo
> "celular" (`npm run remote:setup`), que é outra porta e é pensado para a rede local. Atrás do
> Coolify, protege o acesso com Basic Auth no Traefik ou mantém o domínio privado.
