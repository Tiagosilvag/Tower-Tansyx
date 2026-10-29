# Login e usuários do Tower Tansyx — design

Data: 28/10/2026 · Estado: aguardando aprovação · Mockups: https://claude.ai/artifact/4VainRmpaY4pT3rfeSWSpa (privado)

Este é o primeiro de dois projetos. O segundo, o **kanban** (ideias e tarefas, guardado em SQLite), vem depois e depende
deste: ele precisa saber quem criou e quem mexeu em cada cartão. Este documento cobre só login e usuários.

## Intenção e porquê

Hoje a entrada pela internet passa pelo Caddy com Basic Auth (três usuários: Tiago, ansysar, luciano). O Caddy reescreve
o `Host` e o `Origin` para `localhost`, então o servidor trata **todas** as requisições como "do próprio computador" e não
sabe quem está do outro lado. Consequência: ninguém sabe quem fez o quê.

O objetivo é o servidor **saber quem é o usuário de cada requisição**, com login próprio, e passar a ser a única porta de
entrada (o Caddy sai). Os usos futuros que justificam isso: a marcação de quem mandou cada mensagem no chat, o "criado
por" e o "responsável" do kanban.

## Objetivos

- Tela de login do Tower Tansyx (usuário e senha); sessão por cookie; "Sair".
- Vários usuários, guardados num banco SQLite (`node:sqlite`, embutido no Node, sem dependência nova).
- Tela de administração de usuários: listar, criar, trocar a senha de qualquer um, remover. Qualquer usuário logado pode
  fazer tudo isso (por enquanto não há papéis).
- "Trocar minha senha" no menu do usuário.
- Toda requisição autenticada sabe o **id do usuário** (`req` → usuário), para os projetos seguintes só mostrarem um dado
  que já existe.
- Tirar o Caddy do caminho, **depois** que o login novo estiver provado funcionando.
- Defesa contra tentativa e erro de senha desde a primeira versão (o login passa a ser a única barreira para um terminal
  com acesso root ao hypervisor).

## Não-objetivos

- Papéis ou permissões por usuário (todos podem tudo; a estrutura deixa espaço, sem implementar).
- A marcação do usuário nas mensagens do chat e qualquer coisa do kanban (projetos seguintes).
- Cadastro aberto, "esqueci minha senha" por e-mail, login social, autenticação em dois fatores.
- Cloudflare Access (exige plano pago) e manter o Caddy como proxy.

## Anti-objetivos (seria um fracasso mesmo funcionando)

- O Claude Code (os agentes) **nunca** fica sabendo quem mandou uma mensagem: o texto que chega ao agente é exatamente o
  digitado. A identidade existe só no servidor e na tela.
- Os plugins locais (`habblaud-mensagens`, `habblaud-permissoes`), que falam com o servidor pelo loopback, continuam
  funcionando **sem login**.
- Trancar todo mundo para fora (por exemplo, o freio de tentativas virar um jeito de um atacante bloquear a equipe).
- Segurança menor do que a de hoje: a lista de usuários e qualquer API só respondem a quem está logado.

## Restrições

- O servidor não tem dependências de runtime. `node:sqlite` resolve o banco, mas só é livre de flag a partir do Node 22.13
  (o `package.json` aceita `>=22.12`): subir o mínimo para `>=22.13`. O módulo ainda é marcado como experimental.
- Todo texto visível passa por `tr()` com traduções em `shared/locales/` (`npm run i18n:check`); toda mudança visível
  entra em "Não lançado" no `CHANGELOG.md`.
- Nada em `shared/world/` nem `server/world/` é tocado.
- O servidor continua sem fazer chamadas de rede de saída e sem ler credenciais de terceiros.

## Como é hoje (o que a gente reaproveita)

O Habblaud já tem um acesso remoto autenticado, `server/http/remote.ts`: uma **segunda porta** (4748), separada da
principal (4747, só loopback). Quem separa "local" de "remoto" é a **porta** em que a conexão chegou, nunca o `Host`.
Ele já traz: página de login, cookie de sessão `HttpOnly` + `SameSite=Strict` assinado com HMAC (30 dias), lista de
tokens encerrados por "Sair" (`RemoteSessions`), senha com scrypt (`server/remote/password.ts`), freio de tentativas
(`LoginThrottle`) e a lista do que a sessão remota pode fazer (`HABBLAUD_REMOTE_ALLOW`: `permissions`, `messages`,
`terminal`, `spawn`). Limitações que este projeto remove: **um único usuário** (variáveis de ambiente), o freio é
**global** (cinco erros de qualquer pessoa travam todos) e a sessão não guarda quem é o usuário.

## Abordagens consideradas

1. **Ampliar o acesso remoto existente (escolhida).** Trocar o usuário único por usuários no SQLite, pôr o id do usuário
   na sessão, acrescentar a administração, e apontar o túnel da Cloudflare direto para essa porta. Reaproveita código já
   testado e a separação local/remoto por porta; os truques do Caddy (Host e Origin) deixam de existir. Custo: mexer em
   `remote.ts`, no `remote:setup` e na interface.
2. **Login na porta principal (4747).** Uma porta só, mas os plugins locais perderiam o acesso sem login, e distingui-los
   por cabeçalhos de proxy é frágil (quem controla o cabeçalho decide quem está logado) para uma porta que leva a um shell
   root. Descartada.
3. Manter o Caddy como proxy sem senha / `forward_auth`, ou usar o Cloudflare Access: contrariam a decisão de tirar o
   Caddy e dependem de plano pago. Descartadas.

Você escolheu a 1.

## O que foi decidido (como foi decidido)

- Todos os usuários têm o mesmo acesso e qualquer um administra as contas, numa tela de administração.
- A identidade não é visível ao Claude.
- O Caddy sai; o login do Tower Tansyx é a única porta.
- Login: usuário e senha, sem "criar conta" nem "esqueci minha senha" por e-mail; quem esquece pede a outro usuário, que
  troca a senha na administração.
- Tela de login, bloqueio por tentativas e menu do usuário com administração, como nos mockups aprovados.

## Minhas decisões (marcadas como minhas, para você conferir)

- **Banco:** um arquivo SQLite compartilhado, `~/.habblaud/habblaud.db` (`HABBLAUD_DB` muda o caminho), com a tabela
  `users` (id, usuário único sem diferenciar maiúsculas, nome na tela, cor do avatar, hash scrypt, criado em, último
  acesso). O kanban usará o mesmo arquivo. O arquivo fica fora do repositório.
- **Primeira conta:** por comando no servidor (`npm run users:add`, e também `users:passwd` e `users:list`), no estilo do
  `remote:setup`. Não há tela de "criar o primeiro usuário", porque ela seria uma porta aberta ao público.
- **Sessão:** o token passa a levar o id do usuário (`v2.<id>.<expiração>.<assinatura>`); a chave de cada usuário mistura o
  segredo do servidor com o hash da senha dele, então **trocar a senha derruba as sessões daquele usuário**. 30 dias,
  como hoje. "Sair" continua revogando o token.
- **Freio de tentativas:** por usuário (5 erros seguidos bloqueiam aquele usuário por 15 minutos) mais um freio global
  mais folgado como retaguarda contra quem chuta muitos usuários. O bloqueio é por usuário para um atacante não conseguir
  trancar a equipe toda errando senhas de nomes aleatórios. O scrypt roda sempre, sem atalho que revele se o usuário
  existe.
- **Remover:** ninguém remove a si mesmo nem o último usuário. Remover derruba as sessões do removido.
- **Quem pode o quê no acesso remoto:** a sessão de qualquer usuário recebe `permissions,messages,terminal,spawn`
  (`HABBLAUD_REMOTE_ALLOW`) **e o acesso total** descrito na próxima seção, já que todos podem tudo.
- **Ligar o modo de usuários:** explícito, por `HABBLAUD_REMOTE_USERS=1`. Sem essa variável, o modo antigo de usuário único
  (`HABBLAUD_REMOTE_USER` e `HABBLAUD_REMOTE_PASSWORD_HASH`) continua exatamente como hoje, então quem usa o upstream não
  regride. Com ela e **nenhum usuário no banco**, a porta não sobe e o servidor avisa para rodar `npm run users:add`.

## Acesso total do usuário logado (achado ao ler o código)

O design inicial supunha que bastava liberar as funções em `HABBLAUD_REMOTE_ALLOW`. Não basta: pela porta remota, mesmo
logado e com tudo liberado, o upstream recusa (403) **de propósito** o terminal interativo (`/api/pty*`, assumir e encerrar
agentes, anexos, sugestão do chat, sessões no tmux, projeto novo pelo terminal), atualizar o uso, renomear salas, editar o
personagem e as rotas de hooks, plugins, Codex e auxiliar do host (o teste `server/http/remote.test.ts`, "porta remota",
fixa isso). Hoje tudo isso funciona para vocês só porque o Caddy reescreve o `Host` para `localhost`. Sem o Caddy e sem
tratar isso, vocês perderiam a maior parte do que usam.

Decisão (sua): um modo **opt-in**, `HABBLAUD_REMOTE_FULL=1` (desligado por padrão), em que a sessão **logada pela porta
remota** conta como o próprio computador para:

- terminal interativo e tudo em `/api/pty*` (criar, entrada, fechar, anexar, sugestão, fluxo), `/api/agents/:id/stop` e
  `/api/agents/:id/takeover`;
- Novo agente e Projeto novo (`/api/spawn*`), mensagens, permissões e o terminal de leitura;
- atualizar o uso (`/api/usage/refresh`), renomear salas, editar o personagem.

Continuam **só da máquina**, nunca abertos a uma sessão remota, nem com o modo total e nem com `Host: localhost` forjado:
as rotas dos hooks e plugins (`/api/permissions` POST e `/wait`, `/api/mod/inbox*`), do Codex (`/api/codex/*`), do auxiliar
do host (`/api/host/*`) e o Habblaud World (`/api/world/*`).

Segurança, dita com todas as letras: neste modo, **quem passa pelo login tem um shell root** na máquina (hoje é o mesmo
com a senha do Caddy). Por isso o modo é opt-in, o terminal exige a conexão vir do próprio computador (o `cloudflared`;
`HABBLAUD_REMOTE_HOST=127.0.0.1`), o `Origin` precisa ser o mesmo do `Host` e o freio por usuário vale.
- **Troca do túnel:** o túnel passa a apontar para `http://127.0.0.1:4748`. Entre o `cloudflared` e o servidor o tráfego é
  HTTP puro dentro da própria máquina (`HABBLAUD_REMOTE_INSECURE_HTTP=1`, que o servidor já aceita para esse caso). Para o
  cookie sair `Secure` atrás do túnel, a porta remota confia no `X-Forwarded-Proto: https` **só quando escuta em
  127.0.0.1** (só o `cloudflared` alcança, então ninguém da rede consegue forjar o cabeçalho). Nada na rede local enxerga
  a 4748, e o acesso é só pelo endereço do domínio (`HABBLAUD_ALLOWED_HOSTS` continua valendo).
- **Acesso local sem login:** quem abre a porta principal (4747) na própria máquina continua sem login e **sem usuário**
  (não aparece o chip de usuário). Nos projetos seguintes isso conta como "sem usuário", nunca como um usuário inventado.
- **Usuários iniciais:** crio **Tiago** e **Luciano** (os dois dos mockups). O Caddy tem ainda o `ansysar`; na hora da troca
  eu pergunto a você se ele ganha conta e com que nome. As senhas iniciais são definidas por você na hora.
- **Interface:** a página de login e o menu seguem os mockups; o avatar de cada pessoa tem uma cor escolhida ao criar.

## Como entra no ar (e como volta)

1. Construir e testar com o Caddy ainda de pé.
2. Criar os usuários por `npm run users:add`. As senhas do Caddy são hashes bcrypt e não servem aqui: cada pessoa recebe
   uma senha nova.
3. Subir a porta remota em `127.0.0.1:4748` (com `HABBLAUD_REMOTE_USERS=1`, `HABBLAUD_REMOTE_FULL=1`,
   `HABBLAUD_REMOTE_INSECURE_HTTP=1`, `HABBLAUD_REMOTE_HOST=127.0.0.1` e `HABBLAUD_REMOTE_ALLOW=permissions,messages,terminal,spawn`)
   e testar o login pelo próprio servidor (`curl`), sem mexer no túnel.
4. Trocar o destino do túnel de `localhost:8080` para `localhost:4748`. O túnel é gerenciado remotamente (o
   `cloudflared` roda com `--token-file`), então isso é feito **por você no painel Zero Trust** (hostname público do
   `towertansyx`), não por arquivo no servidor.
5. Com o login provado em uso real, desligar o Caddy. **Volta:** apontar o túnel de volta para `8080` (o Caddy só é
   desligado, não apagado, até todos confirmarem).

## O que fica para quem constrói

Formato exato das tabelas e migrações, nomes dos endpoints (`/api/me`, `/api/users`...), mensagens de erro, textos das
traduções, estilo dos componentes da interface, testes, e a forma de sinalizar ao cliente "sua sessão caiu".

## Riscos conhecidos

- O login vira a única barreira para um terminal com acesso root no hypervisor (a ressalva já registrada no
  `RESUMO-DO-TRABALHO.md`). Mitigações: freio por usuário, scrypt, sessão com cookie `HttpOnly`/`SameSite=Strict`/`Secure`,
  resposta idêntica para usuário e senha errados.
- `node:sqlite` é experimental; uma versão futura do Node pode mudar a API. O acesso fica atrás de uma camada fina
  (`server/db/`) para trocar de implementação sem mexer no resto.
