# Login e usuários do Tower Tansyx — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Login próprio com vários usuários (SQLite), sessão que sabe quem é o usuário, tela de administração, e um modo de acesso total opt-in para o Caddy poder sair.

**Architecture:** Amplia o acesso remoto existente (`server/http/remote.ts`, porta 4748): novo modo de usuários (`HABBLAUD_REMOTE_USERS=1`) com usuários no SQLite (`node:sqlite`), sessão por cookie assinado que leva o id do usuário, freio de tentativas por usuário, rotas `/api/me` e `/api/users`, e o modo `HABBLAUD_REMOTE_FULL=1` em que a sessão logada conta como o próprio computador para terminal interativo, agentes, projeto novo, renomear e uso. O resto do upstream (modo de usuário único, porta local) não muda.

**Tech Stack:** Node >=22.13 (`node:sqlite`), TypeScript, vitest, cliente em TS puro (`client/src/ui/*`).

**Spec:** `docs/superpowers/specs/2026-10-28-login-usuarios-design.md` (mockups: https://claude.ai/artifact/4VainRmpaY4pT3rfeSWSpa). Leia a spec inteira: ela fixa os valores abaixo.

## Global Constraints

- Servidor sem dependências de runtime; o banco é `node:sqlite`. `package.json` `engines.node` passa a `>=22.13`.
- Todo texto visível passa por `tr('texto em PT')` e entra em `shared/locales/{en,es,fr}.ts` (`npm run i18n:check`); toda mudança visível entra em "Não lançado" do `CHANGELOG.md`.
- Não tocar em `shared/world/` nem `server/world/`.
- O Claude Code (os agentes) **nunca** fica sabendo quem mandou uma mensagem: nenhuma tarefa põe usuário no texto entregue ao agente.
- Plugins e hooks locais (porta 4747, loopback) continuam sem login.
- Banco em `~/.habblaud/habblaud.db` (`HABBLAUD_DB` muda); senha com scrypt (`server/remote/password.ts`, mínimo de 10 caracteres como `MIN_PASSWORD` do `remote:setup`).
- Freio: 5 erros seguidos bloqueiam **aquele usuário** por 15 minutos; sessão de 30 dias (`SESSION_MS`); ninguém remove a si mesmo nem o último usuário.
- Mensagem de erro de login idêntica para usuário e senha errados: `Usuário ou senha incorretos.`
- Acesso total só com `HABBLAUD_REMOTE_FULL=1`; rotas de hooks, plugins, Codex, auxiliar do host (`isLocalOnlyPath`) e Habblaud World nunca abrem a sessão remota.

## Review Focus

Cada linha tem o teste que a fixa na tarefa dona do código.

1. Cookie válido de usuário removido, ou de quem teve a senha trocada, deixa de valer na hora (Tarefas 3 e 5).
2. Usuário desconhecido e senha errada dão a mesma resposta e o scrypt roda nos dois casos (Tarefa 3).
3. `"Tiago "` entra como `tiago`; usuário repetido sem diferenciar maiúsculas é 409; nome com `/`, espaço ou `..` é 400 (Tarefa 2).
4. Sessão remota com acesso total não alcança hooks, plugins, Codex, auxiliar do host nem World, mesmo com `Host: localhost` forjado (Tarefa 7).
5. O terminal interativo pela sessão total recusa `Origin` de outro site, `Sec-Fetch-Site: cross-site` e conexão que não vem do loopback; sem login é 401 (Tarefa 7).

---

### Task 1: Camada SQLite

**Files:**
- Create: `server/db/db.ts`
- Test: `server/db/db.test.ts`
- Modify: `package.json` (`engines.node` → `>=22.13`); `grep -rn "22.12"` no repositório e ajustar o que citar o mínimo (README, CONTRIBUTING, `Dockerfile`, `.nvmrc`, CI).

**Interfaces:**
- Produces:
  - `type SqlValue = string | number | null`
  - `interface Db { exec(sql: string): void; get<T>(sql: string, ...p: SqlValue[]): T | undefined; all<T>(sql: string, ...p: SqlValue[]): T[]; run(sql: string, ...p: SqlValue[]): { changes: number; lastInsertRowid: number }; transaction<T>(fn: () => T): T; close(): void }`
  - `const MIGRATIONS: readonly string[]` (índice `i` = versão `i+1`; a 1 cria `users`: `id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL, color TEXT NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL, last_login_at INTEGER`)
  - `function openDb(file: string): Db` — `:memory:` vale; cria a pasta do arquivo; `journal_mode=WAL`, `busy_timeout=5000`, `foreign_keys=ON`; roda as migrações pendentes guiado por `PRAGMA user_version`.

- [ ] **Step 1: Write the failing test** em `server/db/db.test.ts`: `openDb(':memory:')` deixa `PRAGMA user_version` igual a `MIGRATIONS.length` e a tabela `users` existe; abrir um arquivo temporário duas vezes não repete a migração (versão estável, dados mantidos); `transaction` que lança desfaz o `INSERT`; `get` de linha inexistente devolve `undefined`.
- [ ] **Step 2: Run:** `npx vitest run server/db/db.test.ts` — Expected: FAIL (módulo inexistente).
- [ ] **Step 3: Implement `openDb`** em `server/db/db.ts` sobre `DatabaseSync` de `node:sqlite`, embrulhando `prepare(...).get/all/run`; `transaction` com `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`. Todo o acesso ao SQLite do projeto passa por esta camada (para trocar de implementação sem mexer no resto).
- [ ] **Step 4: Run** o teste — Expected: PASS. Rodar também `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(db): camada SQLite com migrações`.

### Task 2: Armazém de usuários

**Files:**
- Create: `server/users/store.ts`
- Test: `server/users/store.test.ts`

**Interfaces:**
- Consumes: `Db`, `openDb` (Tarefa 1).
- Produces:
  - `interface User { id: number; username: string; displayName: string; color: string; createdAt: number; lastLoginAt?: number }`
  - `interface UserRecord extends User { passwordHash: string }`
  - `class UserError extends Error { constructor(readonly status: 400 | 404 | 409, message: string) }`
  - `const AVATAR_COLORS: readonly string[]` = `['#fac665', '#7cc8ff', '#6fd69a', '#ff8a7a', '#c8a2ff', '#ffb3d9']`
  - `function usernameProblem(raw: unknown): string | undefined` — vale `/^[a-z0-9][a-z0-9._-]{0,31}$/i` depois de `trim()`
  - `class UserStore { constructor(db: Db, now?: () => number); count(): number; list(): User[]; get(id: number): User | undefined; record(username: string): UserRecord | undefined; recordById(id: number): UserRecord | undefined; create(i: { username: string; displayName?: string; color?: string; passwordHash: string }): User; setPasswordHash(id: number, hash: string): void; remove(id: number): void; touchLogin(id: number): void }`
  - O `username` é guardado em minúsculas e sem espaços; `displayName` padrão = o `username`; `color` padrão = `AVATAR_COLORS[count() % length]`.

- [ ] **Step 1: Write the failing tests** (usando `openDb(':memory:')`): `create({username:' Tiago ', passwordHash:'x'})` devolve `username:'tiago'`; `create` de `'TIAGO'` depois lança `UserError` 409; `'a/b'`, `'../x'`, `'meu app'`, `''` e 33 caracteres lançam `UserError` 400 (Review Focus 3); `record('Tiago')` acha o registro com `passwordHash`; `list()` e `get()` nunca trazem `passwordHash`; `remove` do único usuário lança 409, do inexistente 404, e de um entre dois remove; `setPasswordHash` de inexistente lança 404; `touchLogin` preenche `lastLoginAt` com o relógio injetado.
- [ ] **Step 2: Run:** `npx vitest run server/users/store.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `UserStore` e `usernameProblem` em `server/users/store.ts` com as assinaturas acima. Mensagens de erro via `tr()`.
- [ ] **Step 4: Run** o teste — Expected: PASS.
- [ ] **Step 5: Commit** `feat(users): armazém de usuários no SQLite`.

### Task 3: Sessões com usuário e freio por usuário

**Files:**
- Create: `server/users/auth.ts`
- Test: `server/users/auth.test.ts`

**Interfaces:**
- Consumes: `UserStore`, `User` (Tarefa 2); `PasswordHash`, `parsePasswordHash`, `verifyPassword`, `hashPassword` de `server/remote/password.ts`; `loadSecret`, `readCookie`, `safeEqual`, `SESSION_MS` de `server/http/remote.ts`.
- Produces:
  - `class UserSessions { constructor(secret: Buffer, lookup: (id: number) => { passwordHash: string } | undefined, now?: () => number, revokedFile?: string); issue(userId: number): { token: string; maxAgeS: number }; verify(token: string | undefined): number | undefined; revoke(token: string | undefined): void }` — token `v2.<id>.<exp>.<assinatura>`; chave da assinatura = HMAC(segredo, `${id}\0${passwordHash}`) lida de `lookup` a cada `verify`; `lookup` indefinido (usuário removido) ⇒ `undefined`; a lista de revogados sobrevive a reinício como em `RemoteSessions`.
  - `class UserThrottle { constructor(now?: () => number); retryAfter(username: string): number; fail(username: string): void; succeed(username: string): void }` — por usuário (normalizado em minúsculas): 5 falhas seguidas bloqueiam 15 min; sucesso zera; nomes desconhecidos contam igual (o mapa tem teto de 1000 entradas, as vencidas saem); retaguarda global: mais de 20 falhas em 60 s fazem `retryAfter` devolver os segundos até a janela baixar de 20, para qualquer nome.
  - `type LoginResult = { ok: true; token: string; maxAgeS: number; user: User } | { ok: false; status: 401 | 429; retryAfter?: number }`
  - `class UserAuth { constructor(store: UserStore, sessions: UserSessions, throttle: UserThrottle, verify?: (password: string, hash: PasswordHash) => Promise<boolean>); login(username: unknown, password: unknown): Promise<LoginResult>; userOf(token: string | undefined): User | undefined; logout(token: string | undefined): void }`
  - `login`: `retryAfter > 0` ⇒ `{ok:false,status:429,retryAfter}`; **sempre** roda `verify` (com um hash de enganação válido quando o usuário não existe); erro ⇒ `throttle.fail` e `{ok:false,status:401}`; acerto ⇒ `throttle.succeed`, `store.touchLogin`, `sessions.issue`. Uma conferência por vez (fila interna) para não paralelizar scrypt.

- [ ] **Step 1: Write the failing tests** em `server/users/auth.test.ts`, com relógio injetado e `verify` falso que conta chamadas: (a) 4 falhas liberam, a 5ª bloqueia só aquele usuário por 900 s e um segundo usuário continua livre; sucesso zera; (b) mais de 20 falhas em 60 s (usuários variados) bloqueiam todos até a janela baixar; (c) `login` de usuário inexistente e de senha errada devolvem o mesmo `{ok:false,status:401}` e `verify` foi chamado nos dois (Review Focus 2); (d) `issue/verify` ida e volta devolve o id; token adulterado ou vencido ⇒ `undefined`; **usuário removido ou `setPasswordHash` ⇒ o mesmo token passa a `undefined`** (Review Focus 1); `revoke` encerra só aquele token e sobrevive a um novo `UserSessions` com o mesmo `revokedFile`; (e) `login` certo devolve `user` sem hash e atualiza `lastLoginAt`.
- [ ] **Step 2: Run:** `npx vitest run server/users/auth.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `server/users/auth.ts` com as assinaturas acima, reaproveitando os helpers de `remote.ts` (exportar o que faltar, sem mudar o comportamento do modo de usuário único).
- [ ] **Step 4: Run** o teste e `npx vitest run server/http/remote.test.ts` — Expected: PASS nos dois.
- [ ] **Step 5: Commit** `feat(users): sessão com usuário, freio por usuário e UserAuth`.

### Task 4: Configuração do modo de usuários e do acesso total

**Files:**
- Modify: `server/http/remote.ts` (`RemoteConfig`, `parseRemoteConfig`), `server/config.ts` (`dbFile`), `shared/types.ts` (`AccessInfo.full?`).
- Test: `server/http/remote.test.ts` (descrever em `parseRemoteConfig`), `server/config.test.ts` se existir.

**Interfaces:**
- Produces: `RemoteConfig` ganha `users: boolean`, `full: boolean`, `trustProxyProto: boolean`; `user`, `passwordHash` e `passwordHashText` ficam opcionais (obrigatórios só quando `!users`). `ServerConfig.dbFile: string` = `HABBLAUD_DB` ou `<dataDir>/habblaud.db`.
- `HABBLAUD_REMOTE_USERS` (verdade pelo `truthy` existente) liga o modo de usuários e dispensa `HABBLAUD_REMOTE_USER`/`..._PASSWORD_HASH`; `HABBLAUD_REMOTE_FULL` liga `full`; `trustProxyProto = !tls && host ∈ {'127.0.0.1','::1'}`. HTTPS continua obrigatório, salvo `HABBLAUD_REMOTE_INSECURE_HTTP=1`.

- [ ] **Step 1: Write the failing tests** em `describe('parseRemoteConfig')`: `{HABBLAUD_REMOTE_USERS:'1', HABBLAUD_REMOTE_INSECURE_HTTP:'1'}` liga com `users:true`, `full:false`, sem usuário/hash; com `HABBLAUD_REMOTE_FULL:'1'` e `HABBLAUD_REMOTE_HOST:'127.0.0.1'` dá `full:true`, `trustProxyProto:true`; sem `INSECURE_HTTP` e sem certificado continua desligado com aviso; o caso antigo (usuário + hash) segue idêntico, com `users:false`.
- [ ] **Step 2: Run:** `npx vitest run server/http/remote.test.ts -t parseRemoteConfig` — Expected: FAIL.
- [ ] **Step 3: Implement** em `parseRemoteConfig` e `loadConfig`; ajustar os usos de `config.remote.user/passwordHash` (o `RemoteSessions` e o portão só os usam no modo de usuário único) para o typecheck passar.
- [ ] **Step 4: Run** `npx vitest run server/http/remote.test.ts` e `npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(remote): modo de usuários e acesso total na configuração`.

### Task 5: Portão com usuários

**Files:**
- Create: `server/users/identity.ts`
- Modify: `server/http/remote.ts` (`RemoteGateDeps`, `createRemoteGate`, `cookieHeader`, `loginPage`)
- Test: `server/users/gate.test.ts`

**Interfaces:**
- Consumes: `UserAuth` (Tarefa 3), `RemoteConfig.trustProxyProto` (Tarefa 4).
- Produces:
  - `function setUser(req: IncomingMessage, user: User): void`, `function userOf(req: IncomingMessage): User | undefined` (WeakMap).
  - `RemoteGateDeps` ganha `users?: UserAuth`; `config` e `sessions` ficam opcionais (um **ou** o outro par: `users`, ou `config`+`sessions`); `secure: boolean | ((req: IncomingMessage) => boolean)`.
  - Com `users`: `POST /api/remote/login` `{user, password}` chama `users.login`; 401 → `{error:'Usuário ou senha incorretos.'}`; 429 → `{error: 'Muitas tentativas. Tente de novo em N s.'}` com `Retry-After`; 200 → `Set-Cookie`; `/api/remote/logout` chama `users.logout`; requisição com cookie válido ganha `setUser(req, user)` antes de seguir. Cookie `Secure` quando `secure` (função) devolve verdadeiro; no `index.ts` (Tarefa 8) a função é `tls || (trustProxyProto && req.headers['x-forwarded-proto'] === 'https')`.
  - `loginPage({ caDownload, users })`: título `Tower Tansyx · entrar`, marca "Tower Tansyx" (Pixelify Sans via CSS embutido, "Tower" creme `#f4f1ea` e "Tansyx" âmbar `#fac665`), subtítulo `Entre para ver o escritório`; o texto antigo do celular continua quando `users` é falso. Os rótulos e a mensagem de erro seguem o mockup aprovado.

- [ ] **Step 1: Write the failing tests** em `server/users/gate.test.ts` (servidor `http` mínimo com `createRemoteGate({ users, secure })` sobre um `UserStore` em memória e `verify` real): login certo ⇒ 200 e cookie `HttpOnly; SameSite=Strict`, e uma rota qualquer atrás do portão enxerga `userOf(req)`; senha errada e usuário inexistente ⇒ 401 com o mesmo corpo; 6ª tentativa errada do mesmo usuário ⇒ 429 com `Retry-After` e o login do outro usuário segue 200; sem login a API é 401 e a página vira `/login`; usuário removido ⇒ o cookie antigo dá 401 (Review Focus 1); `setPasswordHash` ⇒ o cookie antigo dá 401; "Sair" ⇒ o mesmo token deixa de valer; cookie leva `Secure` quando o pedido traz `X-Forwarded-Proto: https` e a função manda confiar; não leva sem isso.
- [ ] **Step 2: Run:** `npx vitest run server/users/gate.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** o ramo de usuários em `createRemoteGate` sem alterar o ramo de usuário único (o `server/http/remote.test.ts` inteiro precisa continuar passando) e a nova `loginPage`.
- [ ] **Step 4: Run** `npx vitest run server/users server/http/remote.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(users): portão de login com usuários e tela de login do Tower Tansyx`.

### Task 6: API de usuários

**Files:**
- Create: `server/users/http.ts`
- Modify: `server/http/app.ts` (`ApiDeps.users?`, despacho), `shared/types.ts` (`UserInfo`)
- Test: `server/users/http.test.ts`

**Interfaces:**
- Consumes: `UserStore`, `UserAuth`, `userOf(req)` (Tarefas 2, 3, 5); `hashPassword`.
- Produces:
  - `shared/types.ts`: `interface UserInfo { id: number; username: string; displayName: string; color: string; createdAt: number; lastLoginAt?: number }` (igual a `User`, sem hash).
  - `function createUsersRoutes(deps: { store: UserStore; auth: UserAuth; readJson: (req: IncomingMessage) => Promise<unknown>; hash?: (password: string) => Promise<string> }): (req: IncomingMessage, res: ServerResponse, url: URL) => boolean`
  - Rotas: `GET /api/me` → `{user: UserInfo | null}` (sem usuário = `null`, 200); `GET /api/users` → `{users: UserInfo[]}`; `POST /api/users` `{username, displayName?, color?, password}` → 201 `UserInfo`; `POST /api/users/:id/password` `{password}` → 204 (se for o próprio, devolve também um `Set-Cookie` novo para a sessão não cair); `POST /api/me/password` `{currentPassword, password}` → 204 com novo `Set-Cookie`; `DELETE /api/users/:id` → 204; 409 para si mesmo e para o último usuário.
  - Tudo, exceto `GET /api/me`, exige `userOf(req)`: sem usuário, 401 `faça login`. Senha com menos de 10 caracteres ⇒ 400. `ApiDeps.users?: (req, res, url) => boolean`, despachado em `app.ts` para `path === '/api/me' || path === '/api/users' || path.startsWith('/api/users/') || path === '/api/me/password'`, depois do bloqueio `isLocalOnlyPath`.

- [ ] **Step 1: Write the failing tests** em `server/users/http.test.ts` (servidor mínimo que põe um usuário via `setUser`): `GET /api/me` com e sem usuário; `GET /api/users` não vaza `passwordHash`; criar usuário ⇒ 201 e ele consegue logar; nome repetido ⇒ 409; senha curta ⇒ 400; trocar a senha de outro invalida as sessões dele; trocar a própria exige `currentPassword` certo (senão 403) e devolve cookie novo que continua válido; remover a si mesmo ⇒ 409; remover o último ⇒ 409; remover outro ⇒ 204 e o cookie dele cai; sem usuário todas as rotas (menos `/api/me`) dão 401.
- [ ] **Step 2: Run:** `npx vitest run server/users/http.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `createUsersRoutes` e o despacho em `app.ts`.
- [ ] **Step 4: Run** `npx vitest run server/users server/http` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(users): API de usuários e do próprio perfil`.

### Task 7: Acesso total da sessão remota

**Files:**
- Modify: `server/http/app.ts` (`ApiDeps.remote`, `trusted`, `/api/access`, `/api/health`), `server/http/pty.ts` (`ptyRequestProblem`, `createPtyRoutes`), `shared/types.ts` (`AccessInfo.full?`)
- Test: `server/http/remote.test.ts` (novo `describe('porta remota com acesso total')`; estender o auxiliar `start` para aceitar `{ full: true }`)

**Interfaces:**
- Produces:
  - `ApiDeps.remote?: { is(req); allows(feature); full: boolean }`.
  - `trusted(req, feature?)`: remoto ⇒ `deps.remote.full || (!!feature && allows(feature))`; local como hoje.
  - `/api/access` e `/api/health`: `usageRefresh` e `pty` valem para remoto quando `full`; `AccessInfo.full` informa o modo.
  - `ptyRequestProblem(req: IncomingMessage, remoteFull = false): string | null` e `createPtyRoutes(ptys: PtyManager, opts?: { remoteFull?: boolean })`: para requisição remota autenticada no modo total, **não** exige Host de loopback, mas continua exigindo (1) o endereço do socket de loopback, (2) `Origin`, se vier, com o mesmo host do `Host`, e (3) `Sec-Fetch-Site` diferente de `cross-site` e `same-site`. Sem o modo total, nada muda. As rotas de `isLocalOnlyPath` e o Habblaud World continuam barradas antes de qualquer outra regra.

- [ ] **Step 1: Write the failing tests** (logado com `['permissions','messages','terminal','spawn']` e `full:true`, mesmo auxiliar do teste existente): `GET /api/pty` ⇒ 200; `POST /api/agents/a1/stop` chega ao `ptys` falso (não é 403); `POST /api/usage/refresh` e renomear sala não dão 403; `/api/health` traz `pty:true`; **Review Focus 4**: `POST /api/permissions`, `GET /api/permissions/p1/wait`, `POST /api/mod/inbox`, `POST /api/codex/events`, `POST /api/host/files/poll`, `GET /api/world/x` seguem 403 mesmo com `Host: localhost`; **Review Focus 5**: `/api/pty` com `Origin: https://evil.example` ⇒ 403, com `Sec-Fetch-Site: cross-site` ⇒ 403, sem cookie ⇒ 401; o teste antigo "terminal interativo ... nunca passam" continua verde sem `full`.
- [ ] **Step 2: Run:** `npx vitest run server/http/remote.test.ts -t "acesso total"` — Expected: FAIL.
- [ ] **Step 3: Implement** as quatro mudanças acima. Conferir no código com `grep -n "trusted(req)" server/http/app.ts` que nenhuma rota de máquina fica aberta por engano (as de `isLocalOnlyPath` já são barradas no topo do roteador).
- [ ] **Step 4: Run** `npx vitest run server/http server/users` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(remote): acesso total opt-in para a sessão logada`.

### Task 8: Ligação no servidor e comandos de usuário

**Files:**
- Modify: `server/index.ts`, `package.json` (scripts)
- Create: `scripts/users.ts`
- Test: `scripts/users.test.ts`

**Interfaces:**
- Consumes: tudo das Tarefas 1 a 7; `askHidden`/leitura de senha escondida de `scripts/remote-setup.ts` (exportar para reaproveitar); `MIN_PASSWORD`.
- Produces:
  - `export async function runUsers(argv: string[], io: { store: UserStore; readPassword(): Promise<string>; out(line: string): void }): Promise<number>` — comandos `add <usuario> [--name "Nome"] [--color #rrggbb]`, `passwd <usuario>`, `list`; devolve o código de saída. `add` pergunta a senha duas vezes (escondida) ou lê uma linha com `--password-stdin`; recusa senha com menos de 10 caracteres.
  - Scripts npm: `users:add`, `users:passwd`, `users:list` → `tsx scripts/users.ts add|passwd|list`.
  - `server/index.ts`: com `config.remote?.users`, abre `openDb(config.dbFile)`, monta `UserStore`, `UserSessions` (segredo em `<dataDir>/remote-secret`, revogados em `remote-revoked.json`), `UserThrottle`, `UserAuth`, `createUsersRoutes` (passados em `ApiDeps.users`, que é criado **antes** do bloco da porta remota), e passa `{ users, secure: (req) => tls || (trustProxyProto && x-forwarded-proto === 'https') }` ao portão; `createPtyRoutes(ptys, { remoteFull: !!config.remote?.full })` e `remote: { ..., full }` em `ApiDeps`. Com o modo de usuários e `store.count() === 0`, **não sobe** a porta e registra `Acesso remoto: nenhum usuário; rode npm run users:add`. O log de subida mostra "usuários" e "acesso total".

- [ ] **Step 1: Write the failing tests** em `scripts/users.test.ts` (`openDb(':memory:')`, `readPassword` falso): `add tiago --name Tiago` cria e `list` mostra `tiago  Tiago` sem hash; `add` repetido (com outra caixa) devolve código ≠ 0 e mensagem; senha de 9 caracteres recusada; `passwd tiago` troca o hash; `passwd` de quem não existe devolve código ≠ 0.
- [ ] **Step 2: Run:** `npx vitest run scripts/users.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `runUsers`, o ponto de entrada do script (abre `openDb` no mesmo caminho do servidor: `HABBLAUD_DB` ou `~/.habblaud/habblaud.db`) e a ligação em `server/index.ts`.
- [ ] **Step 4: Verify:** `npm run typecheck && npx vitest run scripts server` — Expected: PASS. Teste manual do servidor: `HABBLAUD_REMOTE_USERS=1 HABBLAUD_REMOTE_INSECURE_HTTP=1 HABBLAUD_REMOTE_HOST=127.0.0.1 HABBLAUD_DB=/tmp/t.db HABBLAUD_PORT=4799 HABBLAUD_REMOTE_PORT=4798 npx tsx server/index.ts` sem usuários ⇒ log de aviso e porta 4798 fechada; depois de `users:add`, `curl -s -XPOST localhost:4798/api/remote/login -H 'content-type: application/json' -d '{"user":"x","password":"y"}'` ⇒ 401 com `Usuário ou senha incorretos.`.
- [ ] **Step 5: Commit** `feat(users): ligação no servidor e npm run users:add|passwd|list`.

### Task 9: Cliente — chip do usuário, menu e administração

**Files:**
- Create: `client/src/net/me.ts`, `client/src/ui/usermenu.ts`, `client/src/ui/users.ts`, `client/src/ui/users-model.ts`
- Modify: `client/src/ui/topbar.ts` (`addUserChip(el)` no `.ui-topbar__right`), `client/src/ui/index.ts` (montar), `client/src/ui/styles.css`, `shared/locales/{en,es,fr}.ts`
- Test: `client/src/ui/users-model.test.ts`

**Interfaces:**
- Produces:
  - `client/src/net/me.ts`: `fetchMe(): Promise<UserInfo | null>` (`GET /api/me`; erro de rede ⇒ `null`).
  - `users-model.ts` (funções puras): `initialOf(displayName: string): string` (primeira letra maiúscula, `?` se vazio); `passwordProblem(password: string, confirm: string): string | undefined` (menos de 10 caracteres ⇒ `A senha precisa ter pelo menos 10 caracteres.`; diferentes ⇒ `As senhas não são iguais.`); `userRowLabel(u: UserInfo, now: number, meId: number): { name: string; detail: string; isMe: boolean }` (detalhe `usuario · último acesso <tempo relativo>`, `agora` quando for você).
  - `UserMenu` (`UiComponent`): chip com avatar colorido e nome, escondido quando `fetchMe()` devolve `null` (acesso local); menu com **Usuários**, **Trocar minha senha** e **Sair** (`POST /api/remote/logout` e `location.replace('/login')`).
  - `UsersPanel`: popover como nos mockups aprovados: lista (você sem "Remover"), "Trocar senha" por usuário, formulário de novo usuário (usuário, nome na tela, senha inicial), aviso `Todos os usuários têm o mesmo acesso e podem administrar as contas.`; erros do servidor mostrados na tela; usa `/api/users`, `/api/users/:id/password`, `/api/me/password`.

- [ ] **Step 1: Write the failing tests** em `client/src/ui/users-model.test.ts`: `initialOf('tiago')` ⇒ `T`, `initialOf('  ')` ⇒ `?`; `passwordProblem('123456789','123456789')` ⇒ mensagem de 10 caracteres, `('abcdefghij','abcdefghik')` ⇒ mensagem de senhas diferentes, `('abcdefghij','abcdefghij')` ⇒ `undefined`; `userRowLabel` marca `isMe` e formata o último acesso.
- [ ] **Step 2: Run:** `npx vitest run client/src/ui/users-model.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `users-model.ts`, `me.ts`, `UserMenu`, `UsersPanel`, a montagem na barra e os estilos (paleta e tipografia dos mockups; layout que funciona em 400 px). Todo texto com `tr()` e traduções nos três idiomas.
- [ ] **Step 4: Run** `npx vitest run client` , `npm run typecheck` e `npm run i18n:check` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): chip do usuário, menu e administração de usuários`.

### Task 10: Documentação e troca (com você)

**Files:**
- Modify: `README.md`, `README.pt-BR.md` (variáveis `HABBLAUD_REMOTE_USERS`, `HABBLAUD_REMOTE_FULL`, `HABBLAUD_DB`; seção "Acesso por usuários" com `npm run users:add`, e a advertência de que `HABBLAUD_REMOTE_FULL` dá shell root a quem passa pelo login), `CHANGELOG.md` ("Não lançado"), `RESUMO-DO-TRABALHO.md` (arquitetura nova; Caddy desligado depois da troca).

Esta tarefa tem passos que **só valem com você presente**: o painel da Cloudflare é seu.

- [ ] **Step 1:** Escrever as três entradas de documentação acima e rodar `npm run i18n:check`. Commit `docs: acesso por usuários`.
- [ ] **Step 2 (produção, depois do deploy do código):** criar os usuários com `npm run users:add tiago --name Tiago` e `luciano --name Luciano` (você digita as senhas); perguntar a você se `ansysar` ganha conta. Criar o ajuste do serviço `/etc/systemd/system/habblaud.service.d/remote-users.conf` com `HABBLAUD_REMOTE_USERS=1`, `HABBLAUD_REMOTE_FULL=1`, `HABBLAUD_REMOTE_INSECURE_HTTP=1`, `HABBLAUD_REMOTE_HOST=127.0.0.1`, `HABBLAUD_REMOTE_ALLOW=permissions,messages,terminal,spawn`; `systemctl daemon-reload` e `systemctl restart habblaud` (as sessões do tmux continuam).
- [ ] **Step 3:** Verificar **sem tocar no túnel**: `curl` em `127.0.0.1:4748` — login com senha errada ⇒ 401; certo ⇒ cookie; com o cookie, `GET /api/me` ⇒ o usuário, `GET /api/pty` ⇒ 200, `POST /api/permissions` ⇒ 403; log mostra "usuários" e "acesso total".
- [ ] **Step 4 (você):** no painel Zero Trust, trocar o serviço do hostname `towertansyx` de `http://localhost:8080` para `http://localhost:4748`. Abrir o endereço no navegador: tela de login, entrar, abrir um terminal e um projeto novo.
- [ ] **Step 5:** Com o login provado por todos, desligar o Caddy (`systemctl disable --now caddy`, sem apagar `/etc/caddy`) e atualizar o `RESUMO-DO-TRABALHO.md`. **Volta:** apontar o túnel de novo para `8080` e `systemctl enable --now caddy`.
