# Kanban do Tower Tansyx — design

Data: 29/10/2026 · Estado: aprovado para implementar (o usuário pediu para seguir) · Mockups: https://claude.ai/artifact/11oyzJc3fLaBt9yU18Ht69 (privado, versão 4)

Segundo projeto da série (o primeiro, login e usuários, já está em produção). Usa o mesmo banco SQLite e os usuários do login.

## Intenção e porquê

O time (hoje o Tiago e a ansysar) precisa de um lugar para organizar **ideias, tarefas, prioridades e projetos**, dentro do Tower Tansyx, sem depender de nenhum agente. Os agentes entram como ajudantes: criam e alteram cartões a pedido de um usuário e leem os quadros quando ele pedir ("veja o que está em Fazendo no projeto X").

## Objetivos

- Um quadro **Geral** (coisas soltas) e um quadro **por projeto**. O que está no Geral não aparece no quadro do projeto.
- Cartão com título, descrição, prioridade (alta, média, baixa), responsável (um usuário), coluna e posição, "criado por" e histórico de quem mexeu.
- Cartão do Geral pode ter uma **etiqueta de projeto** (só uma referência). "Mover para o projeto" tira o cartão do Geral e o põe no quadro do projeto, sem cópia.
- Interface em pixel art no cenário da sala: o quadro é o quadro branco da parede, os cartões são post-its com fita, os projetos são livros numa **estante lateral retrátil**. Moldura "B" dos mockups.
- **Busca de projetos** (na estante) e **busca de tarefas** (no alto do quadro, só no quadro aberto, ignorando acentos).
- Agentes leem e escrevem por uma API local e um comando de linha; o autor é o usuário que pediu, com a marca **"via agente"**.

## Não objetivos

- Sem papéis nem permissões por quadro: todo usuário vê e edita tudo (igual à administração de usuários).
- Sem colunas personalizáveis, datas de entrega, anexos, etiquetas livres, notificações nem arrastar entre quadros diferentes nesta versão.
- Sem ligação com as sessões nem as salas dos agentes (o Kanban é do time, não dos agentes).
- Sem busca em todos os quadros ao mesmo tempo (decisão minha, ver abaixo).
- Sem integração por MCP ou mod do Claude Code (a interface do agente é HTTP e um comando; ver abordagens).

## Anti-objetivos (seria falha mesmo funcionando)

- O agente **nunca** pode aparecer como um usuário que não pediu, nem derrubar a autoria real: a marca "via agente" é sempre gravada.
- Nada do Kanban pode abrir caminho para o computador (terminal, spawn) pela sessão remota: as rotas só mexem no banco.
- Perder cartões por uma falha de escrita no meio de uma movimentação: mover e reordenar são transações.

## Restrições

- Servidor sem dependências de runtime; banco `node:sqlite` por `server/db/db.ts` (nova migração, nunca editar as antigas).
- Todo texto visível passa por `tr('...')` com traduções em `shared/locales/`; `CHANGELOG.md` em "Não lançado".
- Cliente em TS puro (`client/src/ui/*`); texto de cartão e descrições em fonte do sistema, rótulos e títulos de painel em Pixelify Sans (regra do `styles.css`).
- Não tocar em `shared/world/` nem `server/world/`.
- O banco hoje só abre no modo de usuários; o Kanban precisa funcionar também sem ele (usuário único, porta local).

## Abordagens consideradas

**Como o agente chega ao Kanban**
1. *API HTTP local + comando `npm run kanban`* (escolhida). O Habblaud já tem uma porta local sem login para hooks e plugins; o agente usa `curl` ou o comando. Funciona em qualquer agente (Claude Code e Codex), sem depender da API de mods, que é "early access".
2. Mod do Claude Code com comandos próprios: mais bonito, mas só Claude Code, só nas versões recentes, e mais frágil.
3. Servidor MCP: padrão, mas é uma peça nova e um processo a mais para manter.

**Como guardar o histórico**
1. *Tabela de eventos separada* (escolhida): cada mudança vira uma linha (quem, via, o quê, quando). Simples de consultar e de mostrar.
2. Guardar só o estado atual: perde o "quem mexeu", que é parte do pedido.

**Posição dos cartões**
1. *Inteiro de posição por coluna, renumerado na mesma transação ao mover* (escolhida): poucos cartões por coluna, simples.
2. Posição fracionária (LexoRank): evita renumerar, mas é complexidade sem ganho aqui.

## Modelo de dados (migração nova)

- `boards`: id, kind (`general` | `project`), name, created_at, created_by. Existe sempre exatamente um `general`, criado pela migração.
- `cards`: id, board_id, column (`ideias` | `a_fazer` | `fazendo` | `feito`), position, title, description, priority, assignee_id (user, nulo ao remover o usuário), project_id (etiqueta, só no Geral), created_by, created_via (`user` | `agent`), created_at, updated_at.
- `card_events`: id, card_id, at, actor_id (nulo se desconhecido), via, kind (`created`, `edited`, `moved`, `priority`, `assigned`, `tagged`, `comment`, `moved_board`), detail (texto curto).
- Remover usuário não apaga cartões nem o histórico: `actor_id`/`assignee_id` viram nulos e o nome fica no texto do evento.

## API

Todas sob `/api/kanban`, JSON, `Cache-Control: no-store`.

- `GET /boards` lista os quadros com a contagem de cartões abertos (fora de Feito).
- `POST /boards` cria projeto (nome único sem diferenciar maiúsculas); `PATCH /boards/:id` renomeia; `DELETE /boards/:id` remove projeto vazio ou com `?force=1` (apaga os cartões). O Geral não se remove nem renomeia.
- `GET /boards/:id/cards?q=` cartões do quadro, com busca por título e descrição.
- `POST /boards/:id/cards`, `GET/PATCH/DELETE /cards/:id`, `POST /cards/:id/move` (coluna, posição, e opcionalmente o quadro de destino), `POST /cards/:id/comments`.
- `GET /cards/:id` inclui o histórico.

**Quem é o autor**
- Sessão remota logada (modo de usuários): o usuário da sessão, sempre. `via` é `user`.
- Porta local, chamada de agente (cabeçalho `X-Habblaud-Via: agent`): `as` (nome de usuário) é validado contra os usuários cadastrados; ausente ou desconhecido, o autor fica sem usuário. `via` é `agent`.
- Porta local, página do navegador (sem o cabeçalho): sem usuário e `via` `user` (a porta local não tem login; usuário único).
- `as` e `X-Habblaud-Via` são **ignorados** na porta remota: lá a sessão é a verdade.

## Interface

Botão no cabeçalho abre o Kanban em tela cheia, no estilo dos outros painéis. Moldura B:
- **Estante** à esquerda: Geral no alto, projetos como livros com a contagem, busca de projetos, botão ◀/▶ que recolhe para lombadas com a inicial. A escolha (aberta/recolhida) e o último quadro aberto ficam em `localStorage`.
- **Quadro** com 4 colunas fixas (Ideias, A fazer, Fazendo, Feito), post-its, "+ post-it" no fim de cada coluna, busca de tarefas no alto, arrastar cartão entre colunas (com alternativa por teclado e por menu do cartão, para celular).
- **Cartão aberto** em diálogo: edição dos campos, comentário, histórico com a marca "via agente", botão "Mover para o projeto" no Geral.
- Estados vazios desenhados (quadro sem cartões, busca sem resultado, nenhum projeto ainda).

## Interface do agente

- API acima, na porta local (4747).
- `npm run kanban -- <ação>`: `boards`, `list <quadro> [--q texto]`, `show <id>`, `add <quadro> "título" [--col ...] [--prio ...] [--desc ...] [--as usuário]`, `move <id> <coluna>`, `comment <id> "texto"`, `edit <id> ...`. Saída em texto legível, `--json` para máquina. Zero dependências; manda o cabeçalho de agente.
- Documentação curta em `docs/kanban-agentes.md` para colar no `CLAUDE.md`/`AGENTS.md` do que quiser usar: como ler e alterar, e que o `--as` deve ser o usuário que pediu.

## Decisões minhas (confira)

1. **Colunas fixas** nesta versão (Ideias, A fazer, Fazendo, Feito); personalizar fica para depois.
2. **Busca de tarefas só no quadro aberto**; busca em todos os quadros não entra agora (você não respondeu; é fácil acrescentar depois).
3. **Ordem dos cartões** por posição dentro da coluna; sem data de entrega.
4. **Funciona sem o modo de usuários** (o banco abre sempre; sem usuários, o autor é "sem usuário").
5. **Apagar projeto** pede confirmação e, com cartões, os apaga junto (somente com `force`).
6. **Quadro local sem login** mostra autor vazio; no modo de usuários pela porta remota o autor é sempre o logado.

## O que fica para quem constrói

Nomes de colunas na tradução, cores exatas dos post-its, detalhes de arrastar e soltar (mouse, toque e teclado), limites de tamanho de título e descrição (sugestão: 200 e 5000 caracteres) e a ordem exata dos arquivos do cliente.
