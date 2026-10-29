# Kanban para agentes

O Tower Tansyx tem quadros Kanban (um **Geral** e um por projeto). Os agentes leem e alteram os quadros pelo comando
`npm run kanban`, na pasta do Habblaud, ou direto pela API local. Cole o bloco abaixo no `CLAUDE.md` (Claude Code) ou
no `AGENTS.md` (Codex) do que for usar.

## Bloco para colar

```markdown
## Kanban do Tower Tansyx

Quando o usuário pedir para ver, criar ou mexer em ideias e tarefas do Kanban, use o comando (na pasta do Habblaud):

- `npm run kanban -- boards` lista os quadros (Geral e projetos).
- `npm run kanban -- list <quadro> [--q texto]` lista os cartões de um quadro (o nome, como `Geral`, ou o número).
- `npm run kanban -- show <id>` mostra um cartão com o histórico.
- `npm run kanban -- add <quadro> "título" [--col coluna] [--prio prioridade] [--desc texto] --as <usuário>` cria um cartão.
- `npm run kanban -- move <id> <coluna> --as <usuário>` muda de coluna.
- `npm run kanban -- comment <id> "texto" --as <usuário>` comenta.
- `npm run kanban -- edit <id> [--title ...] [--desc ...] [--prio ...] --as <usuário>` edita.

Colunas: `ideias`, `a_fazer`, `fazendo`, `feito`. Prioridades: `alta`, `media`, `baixa`.
Use `--as` com o **nome de usuário de quem pediu** (por exemplo `tiago`). Nunca invente um usuário: se não souber quem
pediu, omita `--as` e o cartão fica sem autor, marcado só como "via agente". Acrescente `--json` quando precisar da
resposta em formato de máquina.
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
`POST /api/kanban/cards/<id>/comments`. Os corpos são JSON; mande `X-Habblaud-Via: agent` e `"as": "<usuário>"` nas
escritas.
