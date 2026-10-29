# Diário do projeto — Tower Tansyx

Registro de trabalho, do mais recente para o mais antigo. Como as coisas funcionam está no [`KI.md`](KI.md).
Este arquivo é commitado em repositório público: nada de credenciais, infraestrutura, esquema de banco, endpoints internos,
fluxos de autenticação nem dados de pessoas. Entradas antigas não se apagam.

Formato: **data · título** — o que foi feito; pendências e próximos passos; decisões e tentativas que falharam.

---

## 2026-10-29

**Chat: clicar num `.md` citado abre o documento.** Caminho de markdown escrito como código na resposta fica clicável e abre o
arquivo formatado numa janela cheia (mesmo visual das Entregas). Decisões: só markdown, só de pasta de projeto conhecida, nunca
arquivo com cara de segredo, e sempre relido do disco (o agente reescreve o documento). Pendente: deploy (aguarda aprovação);
caminhos escritos fora de código (texto solto) ainda não são clicáveis.

**Diretrizes globais de memória.** Adotadas as diretrizes de `KI.md`/`DIARIO.md` (o diário passou a se chamar `DIARIO.md`). O que
estava nesses arquivos e é proibido por elas (infraestrutura, estrutura sensível, nomes de pessoas) foi retirado; o repositório é
público e o histórico do git ainda contém a versão anterior. Pendente: avaliar os arquivos de `docs/` e o `RESUMO-DO-TRABALHO.md`,
que também têm detalhes de ambiente e de autenticação, e decidir com o dono se saem do repositório. Decisão: o conhecimento
operacional (deploy, ambiente) passa a ficar fora do repo.

**Kanban: carregar conversa anterior no chat.** O chat só lia o fim do transcript; agora há o botão "Carregar conversa anterior"
(500 entradas por clique, para agentes e histórico). Decisão: o teto de itens em tela sobe ao carregar, senão a próxima mensagem
descartaria o que foi pedido.

**Chat: abre sempre em "Só prompts".** Padrão novo para toda janela; a escolha do usuário vale só enquanto a janela está aberta.
Pendente (opcional): lembrar a última escolha.

**Kanban: coluna Revisão.** Nova coluna entre Fazendo e Feito; pelo comando dos agentes, mover para revisão exige `--comment` com o
motivo. Regra gravada no `CLAUDE.md` do usuário de cada conta. A página não obriga o motivo (decisão: não atrapalhar quem arrasta).

**Chat: "Compactando a conversa…".** O transcript não registra a compactação, então o rodapé ficava em "Pensando…". O servidor passou a
ler a saída do terminal do agente e o chat mostra o estado. Limite: só sessões abertas no terminal interativo; depende do texto em
inglês do Claude Code.

**Kanban: Ctrl+V e anexos.** Anexar arquivos nos cartões (botão, arrastar, colar print), com entrega segura (só imagem, PDF e texto
abrem na tela; o resto baixa). Pendente: o comando dos agentes ainda não anexa arquivos; não há teto de espaço total.

**Kanban: agentes de qualquer pasta enxergam o quadro.** Um agente de outro projeto não achava o Kanban porque o comando só rodava na
pasta do Habblaud. Criado o comando `tower-kanban` e o bloco de instruções no `CLAUDE.md` do usuário de cada conta. Conta nova do Claude
Code precisa do mesmo bloco. Sessões já abertas só leem as instruções ao reiniciar.

**Kanban: responsável visível e atualização automática.** O cartão mostra o responsável (avatar na cor da pessoa; cartão novo nasce com
quem o criou) e a janela se atualiza sozinha, com botão de atualizar. Decisão: não recarregar enquanto o usuário digita ou arrasta.
Pendente (opcional): preencher o responsável dos cartões antigos.

**Presença em tempo real.** Pílulas/avatares de quem mais está com o agente aberto e "está digitando…", nas barras do chat e do terminal
e na linha do agente. Tentativa que falhou: o aviso de "digitando" era descartado logo após outro aviso; passou a ser agendado.
Pendente (opcional): trava de "um escreve por vez".

**Marcação de quem escreveu cada mensagem.** Degradê leve na cor do usuário, faixa e nome no chat; o agente não recebe o nome.
Limite: não marca mensagem digitada fora da página.

**Arquivos nas Entregas e senha mínima.** Passaram a abrir como texto sql, json, yaml e código comum; markdown aparece formatado;
Word/PowerPoint/Excel só baixam. Política de tamanho mínimo da senha ajustada.

**Contas de usuário e Kanban em produção.** Liberados para a equipe; ajuste no freio de tentativas do login, com teste.

## 2026-10-28 e antes

- **Conta do GitHub:** repositórios movidos para a conta nova; documentos e remotos atualizados; projetos não usados removidos.
- **Novo agente:** lista de projetos sem pastas inexistentes e com caixa de pesquisa; "+ Projeto novo" cria a pasta, o git e a primeira sessão.
- **Chat:** cartão com a pergunta do agente e a resposta, inclusive com várias perguntas.
- **Nome:** "Tower Tansyx" na aba, no logotipo e nas notificações.
- **Skills:** `superpowers` e `impeccable` instaladas.
- **Kanban:** quadro de ideias e tarefas (Geral e por projeto) em SQLite.
- **Contas de usuário:** desenho e implementação com revisão por tarefa e revisão final (método subagent-driven).
- **Incidente de teste:** uma instância de teste herdou a variável do terminal interativo e se anexou por segundos a sessões reais;
  sem dano. Regra: testes rodam com `HABBLAUD_PTY` vazio.

---

## Em aberto

- Decidir o destino dos documentos em `docs/` e do `RESUMO-DO-TRABALHO.md` que têm detalhes de ambiente e de autenticação.
- Presença: conferir no navegador e, se a equipe quiser, uma trava de "um escreve por vez".
- Kanban: comando dos agentes anexar arquivos; preencher o responsável dos cartões antigos; separar quadros por projeto (a discutir).
- Chat: lembrar a última escolha de filtro, se a equipe quiser.
- Conferir no navegador as telas novas (login, usuários, marcação, presença, anexos, revisão).
