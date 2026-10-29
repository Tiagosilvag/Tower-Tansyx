# Kanban para agentes

O Tower Tansyx tem quadros Kanban (um **Geral** e um por projeto). Os agentes leem e alteram os quadros pelo comando
`tower-kanban` (ou `npm run kanban --`, na pasta do Habblaud), ou direto pela API local.

## Instalação (uma vez por servidor)

Os agentes rodam em qualquer pasta de projeto, então o comando precisa existir fora da pasta do Habblaud. O script
`scripts/tower-kanban` faz isso:

```sh
ln -sf /root/habblaud/scripts/tower-kanban /usr/local/bin/tower-kanban
```

E o bloco abaixo vai no `CLAUDE.md` **do usuário** de cada conta do Claude Code (`<pasta da conta>/CLAUDE.md`, por exemplo
`~/.claude/CLAUDE.md`), assim todo agente, em qualquer projeto, sabe usar o Kanban. Sessões que já estavam abertas só
leem o arquivo na próxima sessão. Para o Codex, o mesmo bloco vai no `AGENTS.md`.

## Bloco para colar

```markdown
## Kanban do Tower Tansyx

Quando o usuário falar do "Kanban", do "quadro" ou pedir para ver, criar ou mexer em ideias e tarefas do Tower Tansyx,
use o comando `tower-kanban` (funciona em qualquer pasta). Não procure um serviço externo: o Kanban é do Tower Tansyx.

- `tower-kanban boards` lista os quadros (Geral e projetos).
- `tower-kanban list <quadro> [--q texto]` lista os cartões de um quadro (o nome, como `Geral`, ou o número).
- `tower-kanban show <id>` mostra um cartão com o histórico.
- `tower-kanban add <quadro> "título" [--col coluna] [--prio prioridade] [--desc texto] [--as <usuário>]` cria um cartão.
- `tower-kanban move <id> <coluna> [--as <usuário>]` muda de coluna.
- `tower-kanban comment <id> "texto" [--as <usuário>]` comenta.
- `tower-kanban edit <id> [--title ...] [--desc ...] [--prio ...] [--as <usuário>]` edita.

Colunas: `ideias`, `a_fazer`, `fazendo`, `feito`. Prioridades: `alta`, `media`, `baixa`.
Você não sabe quem escreveu a mensagem. Só use `--as <usuário>` se a própria pessoa disser quem ela é (por exemplo
"sou o luciano"); nunca invente um usuário. Sem `--as`, o cartão fica sem autor, marcado "via agente". Acrescente
`--json` quando precisar da resposta em formato de máquina.
```

## Como funciona

- O comando fala com o Habblaud local, em `http://127.0.0.1:4747` (ou na porta de `HABBLAUD_PORT`), e se anuncia como
  agente com o cabeçalho `X-Habblaud-Via: agent`. Por isso toda escrita sai com a marca **via agente** no cartão e no
  histórico.
- O autor é o usuário de `--as`, conferido contra os usuários cadastrados. Nome que não existe, ou ausente, deixa o
  autor vazio (sem erro).
- Pela porta remota (a página aberta pela internet) a autoria é sempre o usuário logado: `--as` e o cabeçalho de
  agente são ignorados lá.
- O quadro **Geral** guarda coisas soltas e não aparece nos quadros de projeto. Cartões do projeto ficam no quadro do
  próprio projeto.

## API

Para quem não usar o comando: `GET /api/kanban/boards`, `GET /api/kanban/boards/<id>/cards?q=`, `GET /api/kanban/cards/<id>`,
`POST /api/kanban/boards/<id>/cards`, `PATCH /api/kanban/cards/<id>`, `POST /api/kanban/cards/<id>/move` e
`POST /api/kanban/cards/<id>/comments`. Arquivos anexados: `GET|POST /api/kanban/cards/<id>/files` (POST com
`{name, type, data}` em base64) e `GET|DELETE /api/kanban/files/<id>`; o comando `tower-kanban` ainda não anexa. Os corpos são JSON; mande `X-Habblaud-Via: agent` e `"as": "<usuário>"` nas
escritas.
