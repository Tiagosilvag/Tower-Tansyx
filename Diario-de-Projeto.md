# Diário de Projeto — Tower Tansyx

Log cronológico (o quando e o porquê), entrada nova no topo. O estado atual e onde está cada coisa ficam no
[`KI-Tower-Tansyx.md`](KI-Tower-Tansyx.md). Este arquivo é commitado em repositório **público**: sem credenciais, infraestrutura,
esquema de banco, endpoints internos, fluxos de autenticação nem dados de pessoas. Entradas antigas não se apagam.

---

## 30/10/2026 — Janelas flutuantes sem o limite da barra superior

- **Problema:** o chat (terminal) e o Kanban não subiam acima da barra superior, nem arrastando, nem esticando, nem expandindo.
- **Decisão do dono:** remover o limite para as janelas poderem ocupar a tela inteira.
- **O que foi feito / Arquivos novos:** `client/src/ui/movable.ts` passou a limitar só na borda da tela; a janela que começa acima do
  fim da barra recebe a classe `is-over-bar` e sobe de camada (por cima da barra). O expandir do terminal, do Kanban e do documento
  usa a tela toda. Vale também para a janela de documentos, que usa a mesma peça.
- **Testes:** tipos, testes do cliente e build. Comportamento na tela não conferido (sem navegador). [CONFIRMAR]
- **Limite conhecido:** posições salvas continuam valendo; a barra da janela fica sempre alcançável (não sai pela borda de cima).
- **Para subir / Pendente:** aguardando deploy.

---

## 30/10/2026 — Compactação não aparecia no chat

- **Problema:** durante a compactação o chat ficava em "Pensando…", sem o aviso "Compactando a conversa…".
- **Decisão do dono:** corrigir.
- **O que foi feito / Arquivos novos:** a detecção (`server/pty/compaction.ts`) dependia de a frase "Compacting conversation" ser
  redesenhada; o Claude Code redesenha só o contador, e o aviso expirava em 5 s. Agora, com tmux, o servidor confere a linha com
  contador na tela do terminal para renovar e para detectar; a frase aceita espaço como movimento de cursor. Sem tmux, vale o
  comportamento antigo.
- **Testes:** testes novos em `compaction.test.ts` (tela renova, tela diz que acabou, texto que só cita a frase não conta, limite de
  consultas). Não testado com uma compactação real. [CONFIRMAR em uso real]
- **Limite conhecido:** depende do texto em inglês do Claude Code e da linha com contador na tela visível.
- **Para subir / Pendente:** aguardando deploy.

---

## 30/10/2026 — Nome da sessão editável

- **Problema:** o texto embaixo do nome do agente (título da sessão, vindo do primeiro prompt) não podia ser mudado.
- **Decisão do dono:** lápis ao lado do título que manda `/rename` para a sessão, como o Compactar manda `/compact`.
- **O que foi feito / Arquivos novos:** lápis e campo no painel do agente (`client/src/ui/drawer.ts`); `renameName` (uma linha, sem
  teclas de controle, até 90 caracteres) e `renameKeys` em `client/src/ui/session-info.ts`; o comando e o Enter vão em envios
  separados. O título novo volta pelo histórico da própria sessão, então vale também no histórico e no Claude Code.
- **Testes:** testes de `renameName`/`renameKeys`; tipos. Interface e envio real do `/rename` não conferidos no navegador. [CONFIRMAR]
- **Atualização (30/10/2026):** o lápis sumia com o agente trabalhando e parecia não existir; agora fica visível e apagado, com dica "Espere o agente terminar para renomear."
- **Limite conhecido:** só aparece com a sessão aberta pelo Tower e parada; sessão sem terminal ou do histórico fica só leitura.
- **Para subir / Pendente:** aguardando deploy.

---

## 30/10/2026 — iPhone: texto grande depois de girar o aparelho

- **Problema:** ao deitar o celular e voltar, as letras do chat ficavam no tamanho ampliado da posição deitada.
- **Decisão do dono:** corrigir.
- **O que foi feito / Arquivos novos:** regra `text-size-adjust: 100%` no `html` da página (`client/index.html`); é o aumento automático de
  texto do Safari ao girar.
- **Testes:** build. Sem iPhone nem navegador na máquina: não conferido. [CONFIRMAR no aparelho]
- **Limite conhecido:** se ainda ficar grande, a causa é outra (ex.: zoom da página), e precisa de novo print.
- **Para subir / Pendente:** aguardando deploy.

---

## 30/10/2026 — Celular: fileira de botões recolhível

- **Problema:** no celular a fileira de botões da barra superior ocupava uma linha inteira e tirava espaço do escritório.
- **Decisão do dono:** os botões devem ser retráteis no celular para liberar espaço.
- **O que foi feito / Arquivos novos:** botão de seta na barra superior mostra/esconde a fileira; padrão recolhido; estado salvo no
  navegador; ponto laranja avisa entregas novas escondidas. A altura da barra muda junto (menor recolhida, maior aberta). Só no celular.
- **Testes:** typecheck, traduções, testes da interface e build. Sem navegador na máquina: não conferido em tela.
- **Limite conhecido:** as alturas da barra (recolhida e aberta) são estimadas pelos prints; podem precisar de ajuste fino.
- **Para subir / Pendente:** aguardando deploy e um print novo. [CONFIRMAR visual]

---

## 30/10/2026 — Celular: ajustes de layout (skill impeccable, modo adapt)

- **Problema:** em prints de iPhone, a barra superior ocupava três linhas (acima da altura fixa), o cabeçalho do chat estourava para a
  direita (nome do agente e botões de expandir/fechar sumiam), a caixa de mensagem quebrava os botões em linhas soltas (agravado pelo
  botão Compactar) e o botão de copiar cobria o texto.
- **Decisão do dono:** melhorar layout e visual do celular usando a skill impeccable.
- **O que foi feito / Arquivos novos:** só CSS (`client/src/ui/styles.css`, bloco no fim): barra superior em duas linhas, cabeçalho
  do chat que quebra, caixa de mensagem em linha flexível (texto em linha própria no celular, botões maiores), copiar discreto em
  telas de toque. A skill não estava ativa nesta conta; li as instruções dela na pasta de plugins da outra conta.
- **Testes:** typecheck, build e testes da interface. Sem navegador na máquina: nada foi conferido em tela. A skill pede verificar no
  render; fica como pendência.
- **Limite conhecido:** altura da barra superior segue fixa; com muitos botões novos ela pode estourar de novo. Mapa do escritório
  não foi alterado (o vazio acima dele é a área livre, ele já está centralizado).
- **Para subir / Pendente:** aguardando deploy e um print novo do celular para a segunda rodada. [CONFIRMAR visual]
- **Lição:** **cada botão novo na barra superior exige conferir o celular; a barra tem altura fixa.**

---

## 30/10/2026 — Botão Compactar no chat

- **Problema:** só dava para ver a compactação acontecendo; não havia como pedi-la pelo chat.
- **Decisão do dono:** botão para mandar compactar a sessão quando quiser.
- **O que foi feito / Arquivos novos:** botão "Compactar" ao lado de "Pausar", com confirmação em dois toques; envia o comando e o Enter
  em envios separados. Aparece só com o agente parado e sessão do terminal interativo; some enquanto compacta.
- **Testes:** typecheck, build, traduções e testes da interface. O envio real do comando não foi testado numa sessão viva por mim.
- **Limite conhecido:** sem terminal do Habblaud na sessão (precisa "Assumir daqui") o botão fica desligado.
- **Para subir / Pendente:** aguardando aprovação do deploy. Conferir em uso real que o Claude Code aceita o comando enviado assim. [CONFIRMAR]

---

## 29/10/2026 — Documentos de `docs/` saem do repositório

- **Problema:** os desenhos e planos do login e do Kanban tinham detalhes de ambiente e de autenticação, e o repositório é público.
- **Decisão do dono:** remover do repositório os documentos de `docs/`.
- **O que foi feito / Arquivos novos:** removidos o guia do Kanban para agentes e os desenhos e planos em `docs/superpowers/`; links
  nos dois READMEs retirados. Cópia mantida só na máquina do dono, fora do repositório. Ficaram em `docs/` apenas as imagens do
  Habblaud original e o texto de privacidade do Habblaud World.
- **Testes:** só documentação, nada a testar.
- **Limite conhecido:** o histórico do git ainda contém esses arquivos; `RESUMO-DO-TRABALHO.md` e `PLANO-PTY-ACCESS.md` (raiz) continuam
  no repositório e citam esses caminhos.
- **Para subir / Pendente:** nada de código. Decidir o destino dos dois arquivos da raiz. [CONFIRMAR]
- **Lição:** **desenhos e planos novos não devem ser commitados em `docs/` neste repositório público; guardar fora.**

---

## 29/10/2026 — Diretrizes de memória (segunda versão) e formato novo

- **Problema:** as diretrizes globais mudaram (nomes de arquivo, formato e regras de segurança); o KI e o diário estavam no formato anterior.
- **Decisão do dono:** opção 1: reformatar mantendo o conteúdo genérico, porque o repositório é público.
- **O que foi feito / Arquivos novos:** `KI.md` virou `KI-Tower-Tansyx.md` (com Estado atual, Onde está cada coisa e decisões em tabela);
  `DIARIO.md` virou `Diario-de-Projeto.md` neste formato, com todas as entradas antigas mantidas; `CLAUDE.md` e `AGENTS.md` do
  repositório apontam para os nomes novos.
- **Testes:** só documentação, nada a testar.
- **Limite conhecido:** o histórico do git ainda tem versões antigas dos dois arquivos com detalhes de ambiente (sem credenciais).
- **Para subir / Pendente:** nada de código. Decidir o destino de `docs/` (login, Kanban para agentes), `RESUMO-DO-TRABALHO.md` e
  `PLANO-PTY-ACCESS.md`, que têm detalhes de ambiente. [CONFIRMAR]
- **Lição:** **diretriz de memória mudou duas vezes no mesmo dia; reformatar é barato, então guardar o texto vigente nas contas e não neste repo.**

---

## 29/10/2026 — Chat: clicar num `.md` citado abre o documento

- **Problema:** o chat mostra caminhos de `.md` mas não dava para ler o arquivo sem sair dele.
- **Decisão do dono:** abrir como o visualizador de HTML; depois, ao ver a primeira versão em tela cheia, pediu janela flutuante como o Kanban.
- **O que foi feito / Arquivos novos:** caminho de markdown escrito como código fica clicável e abre formatado numa janela flutuante
  (arrasta, redimensiona, expande, Atualizar, Copiar, Abrir). Servidor: só markdown, só de pasta de projeto conhecida, nunca nome de
  segredo, sempre relido do disco.
- **Testes:** testes do resolvedor de caminho, typecheck, build e traduções. Visual não conferido no navegador por mim.
- **Limite conhecido:** caminho solto no texto, sem crase, não é clicável.
- **Para subir / Pendente:** já em produção.
- **Lição:** **a primeira versão em tela cheia ficou feia; janelas deste projeto seguem o padrão flutuante do Kanban (`Movable`).**

---

## 29/10/2026 — Kanban: carregar conversa anterior no chat

- **Problema:** o chat só lia o fim do transcript e não havia como ver o que veio antes.
- **Decisão do dono:** botão "Carregar conversa anterior".
- **O que foi feito / Arquivos novos:** 500 entradas por clique, para agentes e histórico; o teto de itens em tela sobe ao carregar.
- **Testes:** suíte relacionada; ajuste de teste do estado inicial.
- **Limite conhecido:** só lê para trás em janelas; arquivo muito grande é cortado em início de linha.
- **Para subir / Pendente:** em produção.
- **Lição:** **sem subir o teto de itens, a próxima mensagem descartaria o que o usuário acabou de pedir.**

---

## 29/10/2026 — Chat abre sempre em "Só prompts"

- **Problema:** o chat abria em "Tudo".
- **Decisão do dono:** padrão "Só prompts" em toda janela.
- **O que foi feito / Arquivos novos:** novo padrão; a escolha vale só enquanto a janela está aberta.
- **Testes:** suíte do terminal.
- **Limite conhecido:** a escolha não é lembrada entre aberturas.
- **Para subir / Pendente:** em produção. Opcional: lembrar a última escolha.

---

## 29/10/2026 — Kanban: coluna Revisão

- **Problema:** faltava uma etapa de revisão entre Fazendo e Feito, com o motivo registrado.
- **Decisão do dono:** coluna Revisão; mover para ela exige comentário com o motivo; regra gravada no `CLAUDE.md` das contas.
- **O que foi feito / Arquivos novos:** coluna nova; o comando dos agentes recusa o movimento sem `--comment`.
- **Testes:** testes do Kanban e do comando (colunas de 4 para 5).
- **Limite conhecido:** a página não obriga o motivo (para não atrapalhar quem arrasta).
- **Para subir / Pendente:** em produção.

---

## 29/10/2026 — Chat: "Compactando a conversa…"

- **Problema:** durante a compactação o rodapé ficava em "Pensando…" porque o transcript não registra nada.
- **Decisão do dono:** mostrar o estado no chat.
- **O que foi feito / Arquivos novos:** o servidor lê a saída do terminal do agente e o chat mostra o estado.
- **Testes:** testes do detector de compactação.
- **Limite conhecido:** só sessões abertas no terminal interativo; depende do texto em inglês do Claude Code.
- **Para subir / Pendente:** em produção.

---

## 29/10/2026 — Kanban: anexos e Ctrl+V

- **Problema:** não dava para anexar arquivos nos cartões.
- **Decisão do dono:** anexar (botão, arrastar) e colar print com Ctrl+V.
- **O que foi feito / Arquivos novos:** anexos por cartão com entrega segura (só imagem, PDF e texto abrem na tela; o resto baixa).
- **Testes:** testes do armazenamento e das rotas.
- **Limite conhecido:** o comando dos agentes ainda não anexa; não há teto de espaço total.
- **Para subir / Pendente:** em produção. Opcional: `tower-kanban attach`.

---

## 29/10/2026 — Kanban: agentes de qualquer pasta enxergam o quadro

- **Problema:** um agente de outro projeto não achava o Kanban porque o comando só rodava na pasta do Habblaud.
- **Decisão do dono:** qualquer sessão enxerga o quadro; o escopo de quadros por projeto fica para depois.
- **O que foi feito / Arquivos novos:** comando `tower-kanban` e bloco de instruções no `CLAUDE.md` do usuário de cada conta.
- **Testes:** uso real pelo comando.
- **Limite conhecido:** conta nova do Claude Code precisa do mesmo bloco; sessões abertas só leem as instruções ao reiniciar.
- **Para subir / Pendente:** em produção. Tema "quadros por projeto" adiado pelo dono.

---

## 29/10/2026 — Kanban: responsável visível e atualização automática

- **Problema:** o quadro só atualizava depois de fechar e abrir; o cartão não mostrava o responsável.
- **Decisão do dono:** botão Atualizar e atualização automática; responsável no cartão.
- **O que foi feito / Arquivos novos:** avatar do responsável na cor da pessoa (cartão novo nasce com quem o criou); janela se atualiza sozinha.
- **Testes:** testes do Kanban.
- **Limite conhecido:** não recarrega enquanto o usuário digita ou arrasta.
- **Para subir / Pendente:** em produção. Opcional: preencher o responsável dos cartões antigos.

---

## 29/10/2026 — Presença em tempo real

- **Problema:** não dava para saber quem mais estava com o agente aberto nem quem digitava.
- **Decisão do dono:** avatares e "está digitando…" nas barras do chat e do terminal e na linha do agente; na barra lateral, pílulas (opção A).
- **O que foi feito / Arquivos novos:** presença em memória, aviso periódico do navegador e consulta curta.
- **Testes:** testes de presença e do modelo do cliente.
- **Limite conhecido:** é só aviso, não bloqueia ninguém.
- **Para subir / Pendente:** em produção. Opcional: trava "um escreve por vez"; conferir no navegador.
- **Lição:** **o aviso de "digitando" era descartado logo após outro aviso; passou a ser agendado.**

---

## 29/10/2026 — Marcação de quem escreveu cada mensagem

- **Problema:** difícil diferenciar o que o usuário disse da resposta do agente.
- **Decisão do dono:** degradê leve na cor do usuário (mockup aprovado).
- **O que foi feito / Arquivos novos:** degradê, faixa e nome no chat; o agente não recebe o nome.
- **Testes:** testes do registro e do casamento com o transcript.
- **Limite conhecido:** não marca mensagem digitada fora da página.
- **Para subir / Pendente:** em produção.

---

## 29/10/2026 — Arquivos nas Entregas e política de senha

- **Problema:** sql, md, txt e HTML não abriam nas Entregas; a senha mínima era curta.
- **Decisão do dono:** visualizar texto e HTML; PowerPoint, Word e Excel só baixam; senha mínima maior.
- **O que foi feito / Arquivos novos:** sql, json, yaml e código comum abrem como texto; markdown aparece formatado.
- **Testes:** testes de tipos e do visualizador.
- **Limite conhecido:** sem visualizador para formatos do Office.
- **Para subir / Pendente:** em produção.

---

## 29/10/2026 — Contas de usuário e Kanban em produção

- **Problema:** liberar o acesso da equipe.
- **Decisão do dono:** login com usuários por sócio.
- **O que foi feito / Arquivos novos:** contas e Kanban liberados; ajuste no freio de tentativas do login, com teste.
- **Testes:** testes de autenticação, incluindo o freio.
- **Limite conhecido:** detalhes de configuração ficam fora do repositório.
- **Para subir / Pendente:** em produção.

---

## 28/10/2026 e antes — Preparação do projeto

- **Problema:** montar a base do Tower Tansyx a partir do Habblaud.
- **Decisão do dono:** hospedagem própria; repositório na conta nova do GitHub; contas de usuário; Kanban; nome "Tower Tansyx".
- **O que foi feito / Arquivos novos:** repositórios movidos para a conta nova (documentos e remotos atualizados; projetos não usados
  removidos); novo agente com lista de projetos sem pastas inexistentes e pesquisa, e "+ Projeto novo"; cartão com a pergunta do agente e
  a resposta no chat; nome na aba, logotipo e notificações; skills `superpowers` e `impeccable`; Kanban em SQLite (Geral e por projeto);
  contas de usuário com revisão por tarefa e revisão final (método subagent-driven).
- **Testes:** suíte do projeto; um teste herdou a variável do terminal interativo e se anexou por segundos a sessões reais (sem dano).
- **Limite conhecido:** nenhum novo.
- **Para subir / Pendente:** em produção.
- **Lição:** **testes rodam sempre com `HABBLAUD_PTY` vazio.**

---

## Em aberto

- Decidir o destino dos documentos em `docs/`, do `RESUMO-DO-TRABALHO.md` e do `PLANO-PTY-ACCESS.md` que têm detalhes de ambiente. [CONFIRMAR]
- Presença: conferir no navegador e, se a equipe quiser, uma trava de "um escreve por vez".
- Kanban: comando dos agentes anexar arquivos; preencher o responsável dos cartões antigos; separar quadros por projeto (a discutir).
- Chat: lembrar a última escolha de filtro, se a equipe quiser.
- Conferir no navegador as telas novas (login, usuários, marcação, presença, anexos, revisão, janela de documentos).
