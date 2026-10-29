// Acesso remoto autenticado (celular na mesma rede): uma SEGUNDA porta, com usuário, senha e HTTPS.
//
// A porta principal continua só no loopback (hooks, plugins e o navegador do próprio computador, sem login). A porta
// remota aceita qualquer endereço, mas TODA requisição nela passa por aqui antes da API: sem o cookie de sessão, a
// página vira a tela de login e a API responde 401. O que separa "local" de "remoto" é a porta em que a conexão
// chegou, nunca o cabeçalho Host (que um cliente da rede imita à vontade).
//
// Configuração (escrita por `npm run remote:setup`, scripts/remote-setup.ts):
//   HABBLAUD_REMOTE_USER + HABBLAUD_REMOTE_PASSWORD_HASH  ligam a porta (o hash é scrypt, ver remote/password.ts;
//                                                         senha em texto puro não é aceita)
//   HABBLAUD_REMOTE_ALLOW   o que a sessão remota pode fazer além de ver: permissions, messages, terminal ("none" = só
//                           ver). Padrão: permissions.
//   HABBLAUD_REMOTE_TLS_DIR pasta com server.key, server.crt (e ca.crt, servido em /remote/ca.crt). Padrão:
//                           /remote-tls no Docker, ~/.habblaud/remote-tls/server no Node. Sem certificado a porta não
//                           sobe, a menos que HABBLAUD_REMOTE_INSECURE_HTTP=1 (HTTP puro: senha e cookie à vista na rede).
//   HABBLAUD_REMOTE_PORT / HABBLAUD_REMOTE_HOST  só no Node (padrão 0.0.0.0:4748); no Docker o container escuta sempre
//                           em 0.0.0.0:4748 e quem decide a exposição é a porta publicada (HABBLAUD_REMOTE_BIND).
//
// Sessão: cookie HttpOnly + SameSite=Strict (+ Secure com HTTPS) assinado com HMAC; chave = segredo aleatório em
// <dataDir>/remote-secret misturado com usuário e hash da senha: trocar a senha derruba todas as sessões.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unwatchFile, watchFile, writeFileSync } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parsePasswordHash, verifyPassword, type PasswordHash } from '../remote/password';
import { hostAllowed } from './guard';
import { getLocale, tr } from '../../shared/i18n';
import type { LoginResult, UserAuth } from '../users/auth';
import { setUser } from '../users/identity';

export type RemoteFeature = 'permissions' | 'messages' | 'terminal' | 'spawn';

const FEATURES: readonly RemoteFeature[] = ['permissions', 'messages', 'terminal', 'spawn'];

export interface RemoteTls {
  dir: string;
  keyFile: string;
  certFile: string;
  caFile: string;
}

export interface RemoteConfig {
  port: number;
  host: string;
  /** Modo de usuários (contas no SQLite); então user/passwordHash/passwordHashText não existem. */
  users: boolean;
  /** Acesso total: o celular libera tudo, não só as funções de `allow`. */
  full: boolean;
  /** Atrás de proxy local que termina o TLS: confia no X-Forwarded-Proto. */
  trustProxyProto: boolean;
  /** Só no modo de usuário único. */
  user?: string;
  passwordHash?: PasswordHash;
  /** Texto do hash como veio do ambiente (entra na chave das sessões). */
  passwordHashText?: string;
  allow: ReadonlySet<RemoteFeature>;
  /** Ausente = HTTP puro (só com HABBLAUD_REMOTE_INSECURE_HTTP=1). */
  tls?: RemoteTls;
}

/** Credenciais do modo de usuário único: no modo de usuários não existem, e o portão/sessões antigos não são criados. */
export type SingleUserCreds = Required<Pick<RemoteConfig, 'user' | 'passwordHash' | 'passwordHashText'>>;

export const DEFAULT_REMOTE_PORT = 4748;
export const COOKIE = 'habblaud_remote';
export const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
/** Prazo para o primeiro byte de uma conexão na porta remota (antes de saber se é HTTPS). */
const FIRST_BYTE_MS = 15_000;

function truthy(v: string | undefined): boolean {
  return !!v && /^(1|true|yes|sim|on)$/i.test(v.trim());
}

export function defaultTlsDir(env: NodeJS.ProcessEnv, inDocker: boolean): string {
  if (env.HABBLAUD_REMOTE_TLS_DIR?.trim()) return env.HABBLAUD_REMOTE_TLS_DIR.trim();
  return inDocker ? '/remote-tls' : join(env.HOME || homedir(), '.habblaud', 'remote-tls', 'server');
}

/** Liga o acesso remoto a partir do ambiente. `warning` explica por que ficou desligado quando parece intencional. */
export function parseRemoteConfig(
  env: NodeJS.ProcessEnv,
  inDocker: boolean,
  exists: (path: string) => boolean = existsSync,
): { config?: RemoteConfig; warning?: string } {
  const user = env.HABBLAUD_REMOTE_USER?.trim() ?? '';
  const hashText = env.HABBLAUD_REMOTE_PASSWORD_HASH?.trim() ?? '';
  const plain = env.HABBLAUD_REMOTE_PASSWORD ?? '';
  const users = truthy(env.HABBLAUD_REMOTE_USERS);
  let passwordHash: PasswordHash | undefined;
  if (!users) {
    if (!user && !hashText && !plain) return {};
    if (plain && !hashText) return { warning: tr('acesso remoto desligado: senha em texto puro (HABBLAUD_REMOTE_PASSWORD) não é aceita; rode npm run remote:setup') };
    if (!user || !hashText) return { warning: tr('acesso remoto desligado: faltam HABBLAUD_REMOTE_USER e HABBLAUD_REMOTE_PASSWORD_HASH; rode npm run remote:setup') };
    passwordHash = parsePasswordHash(hashText);
    if (!passwordHash) return { warning: tr('acesso remoto desligado: HABBLAUD_REMOTE_PASSWORD_HASH inválido; rode npm run remote:setup') };
  }
  const dir = defaultTlsDir(env, inDocker);
  const tls: RemoteTls = { dir, keyFile: join(dir, 'server.key'), certFile: join(dir, 'server.crt'), caFile: join(dir, 'ca.crt') };
  const hasTls = exists(tls.keyFile) && exists(tls.certFile);
  const insecure = truthy(env.HABBLAUD_REMOTE_INSECURE_HTTP);
  if (!hasTls && !insecure) return { warning: tr('acesso remoto desligado: sem certificado em {0} (HTTPS é obrigatório); rode npm run remote:setup', [dir]) };
  const rawPort = Number.parseInt(env.HABBLAUD_REMOTE_PORT ?? '', 10);
  const port = inDocker ? DEFAULT_REMOTE_PORT : Number.isInteger(rawPort) && rawPort > 0 && rawPort < 65536 ? rawPort : DEFAULT_REMOTE_PORT;
  const host = inDocker ? '0.0.0.0' : env.HABBLAUD_REMOTE_HOST?.trim() || '0.0.0.0';
  const loopback = host === '127.0.0.1' || host === '::1';
  if (truthy(env.HABBLAUD_REMOTE_FULL) && !hasTls && !loopback) {
    return { warning: tr('acesso remoto desligado: acesso total sem HTTPS próprio só com HABBLAUD_REMOTE_HOST=127.0.0.1 (atrás de um proxy local); em outra interface senha e cookie trafegariam em texto puro') };
  }
  const base = {
    port,
    host,
    users,
    full: truthy(env.HABBLAUD_REMOTE_FULL),
    // Sem TLS próprio e só em loopback: quem fala com a porta é um proxy local que termina o HTTPS.
    trustProxyProto: !hasTls && loopback,
    allow: parseAllow(env.HABBLAUD_REMOTE_ALLOW),
    tls: hasTls ? tls : undefined,
  };
  return { config: users ? base : { ...base, user, passwordHash, passwordHashText: hashText } };
}

export function parseAllow(raw: string | undefined): Set<RemoteFeature> {
  if (raw === undefined || !raw.trim()) return new Set<RemoteFeature>(['permissions']);
  const out = new Set<RemoteFeature>();
  for (const part of raw.split(',')) {
    const p = part.trim().toLowerCase();
    if ((FEATURES as readonly string[]).includes(p)) out.add(p as RemoteFeature);
  }
  return out;
}

/** Segredo de assinatura: lido de `file` ou criado (32 bytes, permissão 600). Sem disco gravável, vale só nesta execução. */
export function loadSecret(file: string): Buffer {
  try {
    if (existsSync(file)) {
      const hex = readFileSync(file, 'utf8').trim();
      if (/^[0-9a-f]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
    }
    const secret = randomBytes(32);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, secret.toString('hex'), { mode: 0o600 });
    chmodSync(file, 0o600);
    return secret;
  } catch {
    return randomBytes(32);
  }
}

/** Compara em tempo constante (os dois lados viram digests do mesmo tamanho). */
export function safeEqual(a: string, b: string): boolean {
  const h = (s: string) => createHash('sha256').update(s, 'utf8').digest();
  return timingSafeEqual(h(a), h(b));
}

/**
 * Tokens encerrados por "Sair" antes de vencer, por assinatura -> validade (o cookie apagado não basta: uma cópia valeria
 * até expirar). Com `file`, a lista sobrevive a reinícios; sem, fica só em memória.
 */
export class RevokedTokens {
  private readonly revoked = new Map<string, number>();

  constructor(
    private readonly now: () => number,
    private readonly file?: string,
  ) {
    this.load();
  }

  has(sig: string): boolean {
    return this.revoked.has(sig);
  }

  add(sig: string, exp: number): void {
    const now = this.now();
    for (const [s, e] of this.revoked) if (e <= now) this.revoked.delete(s);
    this.revoked.set(sig, exp);
    this.save();
  }

  private load(): void {
    if (!this.file) return;
    try {
      const data: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      const now = this.now();
      for (const [sig, exp] of Object.entries(data as Record<string, unknown>)) {
        if (/^[A-Za-z0-9_-]{43}$/.test(sig) && typeof exp === 'number' && exp > now) this.revoked.set(sig, exp);
      }
    } catch {
      // sem arquivo (ou ilegível): ninguém encerrado ainda
    }
  }

  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.revoked)), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch {
      // segue valendo em memória até o próximo reinício
    }
  }
}

export class RemoteSessions {
  private readonly key: Buffer;
  private readonly revoked: RevokedTokens;

  constructor(
    secret: Buffer,
    cfg: Pick<SingleUserCreds, 'user' | 'passwordHashText'>,
    private readonly now: () => number = Date.now,
    /** Onde a lista de tokens encerrados sobrevive a reinícios (ausente = só em memória). */
    revokedFile?: string,
  ) {
    this.key = createHmac('sha256', secret).update(`${cfg.user}\0${cfg.passwordHashText}`, 'utf8').digest();
    this.revoked = new RevokedTokens(now, revokedFile);
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.key).update(payload, 'utf8').digest('base64url');
  }

  issue(): { token: string; maxAgeS: number } {
    const exp = this.now() + SESSION_MS;
    const payload = `v1.${exp}`;
    return { token: `${payload}.${this.sign(payload)}`, maxAgeS: Math.floor(SESSION_MS / 1000) };
  }

  verify(token: string | undefined): boolean {
    const parsed = this.parse(token);
    return !!parsed && !this.revoked.has(parsed.sig);
  }

  /** Encerra este token (botão "Sair"); token inválido ou vencido não muda nada. */
  revoke(token: string | undefined): void {
    const parsed = this.parse(token);
    if (!parsed) return;
    this.revoked.add(parsed.sig, parsed.exp);
  }

  private parse(token: string | undefined): { exp: number; sig: string } | undefined {
    if (!token) return undefined;
    const m = /^v1\.(\d{10,16})\.([A-Za-z0-9_-]{43})$/.exec(token);
    if (!m) return undefined;
    const exp = Number(m[1]);
    if (exp <= this.now()) return undefined;
    const expected = Buffer.from(this.sign(`v1.${m[1]}`));
    const got = Buffer.from(m[2]);
    return expected.length === got.length && timingSafeEqual(expected, got) ? { exp, sig: m[2] } : undefined;
  }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/**
 * Freio contra tentativa e erro: depois de 5 falhas seguidas, cada nova tentativa espera 2^(n-5) s (até 5 min).
 * Global, não por IP: no Docker todo cliente da rede chega com o endereço do gateway. Uma conferência de senha por vez
 * (begin/end), contada como falha desde o começo: tentativas em paralelo não passam pelo freio enquanto o scrypt roda.
 */
export class LoginThrottle {
  private failures = 0;
  private blockedUntil = 0;
  private busy = false;

  constructor(private readonly now: () => number = Date.now) {}

  /** Segundos até poder tentar de novo (0 = pode; 1 enquanto outra tentativa está em andamento). */
  retryAfter(): number {
    return Math.max(this.busy ? 1 : 0, Math.ceil((this.blockedUntil - this.now()) / 1000));
  }

  /** Começa uma tentativa (já contada como falha); false se o freio ou outra tentativa não deixam. */
  begin(): boolean {
    if (this.retryAfter() > 0) return false;
    this.busy = true;
    this.fail();
    return true;
  }

  /** Fim da tentativa começada em begin(): acertou zera o freio; errou fica a falha já contada. */
  end(ok: boolean): void {
    this.busy = false;
    if (ok) this.succeed();
  }

  fail(): void {
    this.failures++;
    if (this.failures >= 5) this.blockedUntil = this.now() + Math.min(300, 2 ** (this.failures - 5)) * 1000;
  }

  succeed(): void {
    this.failures = 0;
    this.blockedUntil = 0;
  }
}

/** Requisições que chegaram pela porta remota e passaram pelo login. */
const remoteRequests = new WeakSet<IncomingMessage>();
/** Arquivos que a porta remota serve sem login: manifesto e ícones (o celular os busca antes do login, sem o
 *  cookie). Nada da API nem do escritório. */
const PUBLIC_STATIC = /^\/(manifest\.webmanifest|assets\/brand\/[\w.@-]+\.png)$/;

export function isRemoteRequest(req: IncomingMessage): boolean {
  return remoteRequests.has(req);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(data);
}

function readBody(req: IncomingMessage, max = 8 * 1024): Promise<string> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= max) chunks.push(c);
    });
    req.on('end', () => (size > max ? fail(new Error(tr('corpo grande demais'))) : ok(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', fail);
  });
}

export const CA_PATH = '/remote/ca.crt';

/** Texto nosso (tr) dentro do HTML: escapa o que o HTML interpretaria. */
function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Dentro do <script>: JSON com "<" escapado, para nenhum texto fechar a tag. */
function js(text: string): string {
  return JSON.stringify(text).replace(/</g, '\\u003c');
}

/** Envio do formulário, igual nos dois modos: o texto de erro mostrado é o que o servidor mandou. */
function loginScript(noConnection: string): string {
  return `<script>
  const f = document.getElementById('f'), b = document.getElementById('b'), err = document.getElementById('err');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    b.disabled = true; err.textContent = '';
    try {
      const r = await fetch('/api/remote/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin', body: JSON.stringify({ user: f.username.value, password: f.password.value }) });
      if (r.ok) { location.replace('/'); return; }
      const body = await r.json().catch(() => ({}));
      err.textContent = body.error || ${js(tr('Não deu para entrar.'))};
    } catch { err.textContent = ${js(noConnection)}; }
    b.disabled = false;
  });
</script>`;
}

function caParagraph(): string {
  return `<p class="ca">${esc(tr('Primeira vez neste celular?'))} <a href="${CA_PATH}" download="habblaud-ca.crt">${esc(tr('Instale o certificado do Habblaud'))}</a> ${esc(tr('para tirar o aviso de segurança (confira a impressão digital que o npm run remote:setup mostrou).'))}</p>`;
}

/**
 * Tela de login. `users` = modo de usuários: a marca do Tower Tansyx (como no mockup aprovado), com a fonte só
 * nomeada no CSS: a tela não busca nada em outro host. Sem `users`, a tela de sempre do Habblaud.
 */
export function loginPage(opts: { caDownload: boolean; users: boolean }): string {
  if (opts.users) return towerLoginPage(opts.caDownload);
  const ca = opts.caDownload ? caParagraph() : '';
  return `<!doctype html>
<html lang="${getLocale()}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${esc(tr('Habblaud · entrar'))}</title>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/assets/brand/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Habblaud">
<meta name="apple-mobile-web-app-status-bar-style" content="black">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #14161f; color: #e8e6df;
         font: 16px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; padding: 16px; }
  form { width: 100%; max-width: 360px; background: #1e2130; border: 2px solid #3a3f58; border-radius: 10px; padding: 24px; }
  h1 { margin: 0 0 4px; font-size: 22px; color: #f4c95d; }
  p { margin: 0 0 20px; color: #9aa0b8; font-size: 13px; }
  p.ca { margin: 20px 0 0; }
  a { color: #f4c95d; }
  code { color: #e8e6df; }
  label { display: block; font-size: 13px; color: #9aa0b8; margin: 12px 0 6px; }
  input { width: 100%; padding: 12px; font: inherit; color: inherit; background: #14161f; border: 2px solid #3a3f58; border-radius: 6px; }
  input:focus { outline: none; border-color: #f4c95d; }
  button { width: 100%; margin-top: 20px; padding: 12px; font: inherit; font-weight: 700; color: #14161f; background: #f4c95d;
           border: 0; border-radius: 6px; cursor: pointer; }
  button:disabled { opacity: .6; cursor: wait; }
  #err { min-height: 20px; margin-top: 12px; color: #ff8a80; font-size: 13px; }
</style>
</head>
<body>
<form id="f" autocomplete="on">
  <h1>Habblaud</h1>
  <p>${esc(tr('Acesso pelo celular. Entre com o usuário e a senha que você escolheu no npm run remote:setup.'))}</p>
  <label for="u">${esc(tr('Usuário'))}</label>
  <input id="u" name="username" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required>
  <label for="p">${esc(tr('Senha'))}</label>
  <input id="p" name="password" type="password" autocomplete="current-password" required>
  <button id="b" type="submit">${esc(tr('Entrar'))}</button>
  <div id="err" role="alert"></div>
  ${ca}
</form>
${loginScript(tr('Sem conexão com o Habblaud.'))}
</body>
</html>
`;
}

function towerLoginPage(caDownload: boolean): string {
  const ca = caDownload ? caParagraph() : '';
  return `<!doctype html>
<html lang="${getLocale()}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${esc(tr('Tower Tansyx · entrar'))}</title>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/assets/brand/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Tower Tansyx">
<meta name="apple-mobile-web-app-status-bar-style" content="black">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b0f18; color: #e8ecf5;
         font: 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; padding: 16px; }
  form { width: 100%; max-width: 360px; display: flex; flex-direction: column; gap: 16px; padding: 36px 26px 30px;
         background: radial-gradient(120% 80% at 50% 0%, #17223a 0%, #121826 62%); border: 1px solid #26304a; border-radius: 10px; }
  .brand { margin: 0 0 4px; text-align: center; font-family: "Pixelify Sans", ui-monospace, monospace; font-weight: 700;
           font-size: 28px; line-height: 1; letter-spacing: .02em; text-shadow: 2px 2px 0 rgba(6, 8, 14, .7); }
  .tower { color: #f4f1ea; }
  .tansyx { color: #fac665; }
  .sub { margin: -6px 0 0; text-align: center; color: #8c97b2; font-size: 12px; }
  .field { display: flex; flex-direction: column; gap: 5px; }
  label { font-size: 12px; color: #8c97b2; }
  input { width: 100%; min-height: 40px; padding: 9px 11px; font: inherit; font-size: 16px; color: inherit; background: #0d1220;
          border: 1px solid #26304a; border-radius: 6px; }
  input:focus { outline: none; border-color: #fac665; }
  button { padding: 11px 14px; font: inherit; font-weight: 600; color: #1a1405; background: #fac665; border: 0; border-radius: 6px;
           cursor: pointer; }
  button:disabled { color: #8e95a8; background: #3a3f50; cursor: wait; }
  #err { padding: 9px 11px; font-size: 13px; color: #ff8a7a; background: rgba(255, 138, 122, .08); border: 1px solid #5a2e2e;
         border-radius: 6px; }
  #err:empty { display: none; }
  p.ca { margin: 4px 0 0; text-align: center; color: #8c97b2; font-size: 12px; }
  a { color: #fac665; }
</style>
</head>
<body>
<form id="f" autocomplete="on">
  <h1 class="brand"><span class="tower">Tower</span> <span class="tansyx">Tansyx</span></h1>
  <p class="sub">${esc(tr('Entre para ver o escritório'))}</p>
  <div class="field">
    <label for="u">${esc(tr('Usuário'))}</label>
    <input id="u" name="username" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required>
  </div>
  <div class="field">
    <label for="p">${esc(tr('Senha'))}</label>
    <input id="p" name="password" type="password" autocomplete="current-password" required>
  </div>
  <div id="err" role="alert"></div>
  <button id="b" type="submit">${esc(tr('Entrar'))}</button>
  ${ca}
</form>
${loginScript(tr('Sem conexão com o Tower Tansyx.'))}
</body>
</html>
`;
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(html);
}

/** Set-Cookie da sessão remota. Exportado para a API de usuários (troca de senha) emitir o cookie igual ao do login. */
export function cookieHeader(value: string, maxAgeS: number, secure: boolean): string {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}${secure ? '; Secure' : ''}`;
}

/** Quem está tentando o login: o IP do CF-Connecting-IP só vale atrás de proxy local; senão, o do socket. */
export function clientOf(req: IncomingMessage, trustProxy = false): string {
  const header = req.headers['cf-connecting-ip'];
  const forwarded = typeof header === 'string' ? header.trim() : '';
  // formato de IP (v4 ou v6), sem lixo: o valor vira chave de mapa
  if (trustProxy && /^[0-9a-fA-F:.]{2,45}$/.test(forwarded)) return forwarded.toLowerCase();
  return req.socket.remoteAddress ?? '';
}

/**
 * Um modo ou o outro: `users` (contas no SQLite) ou `config` + `sessions` (usuário único do ambiente).
 */
export interface RemoteGateDeps {
  config?: Pick<SingleUserCreds, 'user' | 'passwordHash'>;
  sessions?: RemoteSessions;
  users?: UserAuth;
  /** Cookie com Secure (a porta fala HTTPS). Função = decidido a cada pedido (proxy que termina o TLS). */
  secure: boolean | ((req: IncomingMessage) => boolean);
  /** Arquivo da CA pública servido em /remote/ca.crt (ausente = sem download). */
  caFile?: string;
  throttle?: LoginThrottle;
  /** Atrás de proxy local (cloudflared): o cliente do freio de login vem do CF-Connecting-IP. */
  trustProxy?: boolean;
  /** Conferência da senha (injetável nos testes; padrão: scrypt). */
  verify?: (password: string, hash: PasswordHash) => Promise<boolean>;
}

/**
 * Filtro da porta remota, depois do guard (Host/Origin/JSON) e antes da API: devolve true quando já respondeu (login,
 * logout, 401, redirecionamento, CA) e false quando a requisição está autenticada — e então a marca como remota.
 */
export function createRemoteGate(deps: RemoteGateDeps): (req: IncomingMessage, res: ServerResponse, url: URL) => boolean {
  const { users } = deps;
  // Os dois modos juntos (ou nenhum) seria um portão que ninguém sabe qual senha confere: erro de montagem, não de uso.
  if (users ? !!(deps.config || deps.sessions) : !(deps.config && deps.sessions)) {
    throw new Error(tr('createRemoteGate: passe users, ou config e sessions (só um dos dois modos)'));
  }
  const throttle = deps.throttle ?? new LoginThrottle();
  const verify = deps.verify ?? verifyPassword;
  const caAvailable = () => !!deps.caFile && existsSync(deps.caFile);
  const secureFor = (req: IncomingMessage) => (typeof deps.secure === 'function' ? deps.secure(req) : deps.secure);
  return (req, res, url) => {
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const token = readCookie(req.headers.cookie, COOKIE);
    // Modo de usuários: o usuário é relido a cada pedido, então removido ou com senha trocada já não passa.
    const user = users?.userOf(token);
    const authed = users ? !!user : deps.sessions!.verify(token);

    if (path === '/api/remote/login' && users) {
      if (method !== 'POST') {
        sendJson(res, 405, { error: tr('método não permitido') }, { Allow: 'POST' });
        return true;
      }
      // O freio e a fila de conferências ficam no UserAuth (por usuário, então precisa do nome que vem no corpo).
      readBody(req)
        .then(async (raw) => {
          let body: { user?: unknown; password?: unknown } = {};
          try {
            const parsed: unknown = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') body = parsed as typeof body;
          } catch {
            // corpo inválido: vira usuário e senha vazios, recusados como qualquer erro
          }
          let result: LoginResult;
          try {
            result = await users.login(body.user, body.password, clientOf(req, deps.trustProxy));
          } catch {
            // falha do armazém depois da senha certa: resposta genérica, sem cookie e sem a mensagem de dentro
            return sendJson(res, 500, { error: tr('erro interno') });
          }
          if (result.ok) {
            return sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(result.token, result.maxAgeS, secureFor(req)) });
          }
          if (result.status === 429) {
            const wait = Math.max(1, result.retryAfter ?? 1);
            return sendJson(res, 429, { error: tr('Muitas tentativas. Tente de novo em {0} s.', [wait]) }, { 'Retry-After': String(wait) });
          }
          // o mesmo texto para nome inexistente e senha errada: a resposta não revela quem existe
          sendJson(res, 401, { error: tr('Usuário ou senha incorretos.') });
        })
        .catch(() => {
          if (!res.headersSent) sendJson(res, 400, { error: tr('requisição inválida') });
        });
      return true;
    }

    if (path === '/api/remote/login') {
      if (method !== 'POST') {
        sendJson(res, 405, { error: tr('método não permitido') }, { Allow: 'POST' });
        return true;
      }
      const single = { config: deps.config!, sessions: deps.sessions! };
      const tooMany = () => {
        const wait = Math.max(1, throttle.retryAfter());
        sendJson(res, 429, { error: tr('Muitas tentativas. Tente de novo em {0} s.', [wait]) }, { 'Retry-After': String(wait) });
      };
      if (throttle.retryAfter() > 0) {
        req.resume();
        tooMany();
        return true;
      }
      // A tentativa só começa (e ocupa o freio) com o corpo inteiro na mão: um corpo que nunca termina não trava o
      // login de mais ninguém.
      let begun = false;
      let ok = false;
      readBody(req)
        .then(async (raw) => {
          if (!throttle.begin()) return tooMany();
          begun = true;
          let body: { user?: unknown; password?: unknown } = {};
          try {
            body = JSON.parse(raw) as typeof body;
          } catch {
            // corpo inválido: cai na recusa abaixo
          }
          const user = typeof body.user === 'string' ? body.user : '';
          const password = typeof body.password === 'string' ? body.password : '';
          // O scrypt roda sempre (sem atalho que denuncie se foi o usuário ou a senha que errou).
          const okPassword = await verify(password, single.config.passwordHash);
          const okUser = safeEqual(user.trim(), single.config.user);
          if (!(okUser && okPassword)) return sendJson(res, 401, { error: tr('Usuário ou senha incorretos.') });
          ok = true;
          const { token, maxAgeS } = single.sessions.issue();
          sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(token, maxAgeS, secureFor(req)) });
        })
        .catch(() => {
          if (!res.headersSent) sendJson(res, 400, { error: tr('requisição inválida') });
        })
        .finally(() => {
          if (begun) throttle.end(ok);
        });
      return true;
    }

    if (path === '/api/remote/logout') {
      req.resume();
      if (method !== 'POST') sendJson(res, 405, { error: tr('método não permitido') }, { Allow: 'POST' });
      else {
        if (users) users.logout(token);
        else deps.sessions!.revoke(token);
        sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader('', 0, secureFor(req)) });
      }
      return true;
    }

    if (path === CA_PATH) {
      // Público de propósito: é só o certificado da CA (a chave nunca sai do computador).
      req.resume();
      if (!caAvailable()) sendJson(res, 404, { error: tr('sem certificado da CA') });
      else {
        const pem = readFileSync(deps.caFile!);
        res.writeHead(200, {
          'Content-Type': 'application/x-x509-ca-cert',
          'Content-Disposition': 'attachment; filename="habblaud-ca.crt"',
          'Content-Length': pem.length,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(pem);
      }
      return true;
    }

    if (path === '/login') {
      req.resume();
      if (authed) {
        res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' });
        res.end();
      } else sendHtml(res, loginPage({ caDownload: caAvailable(), users: !!users }));
      return true;
    }

    if (authed) {
      remoteRequests.add(req);
      // a API (userOf) fica sabendo quem pediu
      if (user) setUser(req, user);
      return false;
    }
    // Ícone e manifesto do app (Tela de Início): públicos, o celular os busca antes do login (e sem o cookie).
    if ((method === 'GET' || method === 'HEAD') && PUBLIC_STATIC.test(path)) {
      remoteRequests.add(req);
      return false;
    }

    req.resume();
    if (path === '/api' || path.startsWith('/api/')) {
      sendJson(res, 401, { error: tr('faça login: abra o Habblaud por esta porta no navegador e entre com usuário e senha') });
    } else {
      res.writeHead(302, { Location: '/login', 'Cache-Control': 'no-store' });
      res.end();
    }
    return true;
  };
}

export interface RemoteListener {
  /** O que escuta a porta (TCP com HTTPS + redirecionamento, ou HTTP puro). */
  server: net.Server;
  close(): void;
}

/**
 * Sobe a porta remota. Com HTTPS, um servidor TCP olha o primeiro byte de cada conexão: 0x16 (TLS ClientHello) vai para
 * o HTTPS; qualquer outra coisa é HTTP digitado sem "s" e recebe 308 para https://. O certificado é recarregado sozinho
 * quando o arquivo muda (npm run remote:setup ou a renovação do docker:up), sem derrubar quem está conectado.
 */
export function startRemoteListener(
  cfg: Pick<RemoteConfig, 'port' | 'host' | 'tls'>,
  onRequest: (req: IncomingMessage, res: ServerResponse) => void,
  log: { info(m: string): void; warn(m: string): void; error(m: string): void },
  allowedHosts: ReadonlySet<string> = new Set(),
): RemoteListener {
  if (!cfg.tls) {
    const plain = http.createServer(onRequest);
    plain.on('error', (err) => log.error(tr('Acesso remoto: não deu para escutar na porta {0} ({1}).', [cfg.port, (err as Error).message])));
    plain.listen(cfg.port, cfg.host);
    return { server: plain, close: () => plain.close() };
  }
  const tls = cfg.tls;
  const read = () => ({ key: readFileSync(tls.keyFile), cert: readFileSync(tls.certFile) });
  const secure = https.createServer(read(), onRequest);
  secure.on('tlsClientError', () => {
    // Celular que ainda não confia na CA fecha o aperto de mão: normal até instalar o certificado.
  });
  const reload = () => {
    try {
      secure.setSecureContext(read());
      log.info(tr('   Acesso remoto: certificado recarregado.'));
    } catch (err) {
      log.warn(tr('   Acesso remoto: certificado novo ilegível, mantendo o anterior ({0}).', [(err as Error).message]));
    }
  };
  watchFile(tls.certFile, { interval: 15_000 }, (cur, prev) => {
    if (cur.mtimeMs !== prev.mtimeMs || cur.ino !== prev.ino) reload();
  });
  const redirect = http.createServer((req, res) => {
    const host = req.headers.host;
    req.resume();
    if (!host || !hostAllowed(host, allowedHosts)) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`${tr('Use https://')}\n`);
      return;
    }
    res.writeHead(308, { Location: `https://${host}${req.url ?? '/'}`, 'Cache-Control': 'no-store' });
    res.end();
  });
  const tcp = net.createServer((socket) => {
    // Conexão que não manda nada não fica pendurada para sempre.
    socket.setTimeout(FIRST_BYTE_MS, () => socket.destroy());
    socket.once('data', (first: Buffer) => {
      socket.setTimeout(0);
      socket.pause();
      socket.unshift(first);
      (first[0] === 0x16 ? secure : redirect).emit('connection', socket);
      process.nextTick(() => socket.resume());
    });
    socket.on('error', () => socket.destroy());
  });
  tcp.on('error', (err) => log.error(tr('Acesso remoto: não deu para escutar na porta {0} ({1}).', [cfg.port, (err as Error).message])));
  tcp.listen(cfg.port, cfg.host);
  return {
    server: tcp,
    close: () => {
      unwatchFile(tls.certFile);
      tcp.close();
      secure.close();
      redirect.close();
    },
  };
}
