# Aia · arquitetura e decisões

## Objetivo

Secretária pessoal do Ricardo operando por WhatsApp: recebe ordens dele, mantém pendências e lembretes, conversa com familiares autorizados e, no começo, **consulta o Ricardo antes de qualquer mensagem a terceiros**. A autonomia cresce por decisão explícita dele, por contato e por tipo de ação.

## Decisões tomadas

| Tema | Decisão | Motivo |
|---|---|---|
| Canal | Extensão do Chrome no WhatsApp Web, notebook Windows dedicado | Escolha do Ricardo para o protótipo; risco de banimento aceito porque o número é secundário |
| Leitura/envio | Biblioteca WA-JS (WPPConnect) injetada na página, não leitura de HTML | HTML do WhatsApp Web muda toda semana; WA-JS expõe eventos e funções internas estáveis |
| Conta | Número secundário com WhatsApp Business, só dele | Só vê o que mandam para ela; o número pessoal do Ricardo nunca é automatizado |
| Cérebro | Servidor Node local + Claude API (`claude-opus-5-5`) | Extensão sozinha adormece; servidor dá agendador, banco, log e integrações futuras |
| Permissões | Camada de política em código, não em prompt | O modelo decide o que dizer; o código decide se pode sair agora |
| Entrada | Só texto na v1 | Áudio exige download de mídia e transcrição; fica para a v2 |
| Terceiros | Familiares próximos, lista branca | Baixo volume, baixo risco |
| Nome/tom | Aia; proativa, educada, direta, sem floreios | Pedido do Ricardo |
| Resumo | Diário às 17:00 | Pedido do Ricardo |

## Componentes

```
WhatsApp Web (aba do Chrome)
  └─ page.js + WA-JS  (mundo MAIN)  ── window.postMessage ──┐
                                                            │
  bridge.js (mundo ISOLATED) ── chrome.runtime port ── background.js (service worker)
                                                            │ WebSocket ws://127.0.0.1:8787/ext
servidor Node (aia/server)                                  │
  ws.ts              ponte: eventos de mensagem, comandos send/markRead/resolve
  handlers/inbound   roteador: pareamento, desconhecidos, dono, familiares
  handlers/approvals "ok 12", "não 12", "12: texto", resposta citando proposta
  handlers/commands  atalhos fixos sem IA
  agent/claude.ts    loop de ferramentas com a API do Claude
  agent/tools.ts     ferramentas do dono e do familiar
  policy.ts          níveis de autonomia por (contato, ação)
  outbox.ts          toda saída passa aqui; cria proposta ou envia
  scheduler.ts       lembretes, expiração de propostas, resumo diário
  db.ts              SQLite (node:sqlite): contatos, tarefas, lembretes, propostas, mensagens, auditoria
```

## Fluxos principais

**Dono manda uma ordem.** inbound → não é aprovação nem atalho → agente em modo dono com snapshot (tarefas, contatos, propostas, hora) → ferramentas → resposta curta.

**Dono pede recado para familiar.** agente chama `send_message(requested_by_owner=true)` → outbox consulta política `relay` (padrão nível 2) → envia e avisa o dono.

**Familiar escreve.** inbound → contato autorizado e não pausada → agente em modo familiar (só vê tarefas daquela pessoa) → texto final → outbox consulta política `reply` (padrão nível 1) → cria proposta e avisa o dono → dono responde `ok N` → outbox envia.

**Lembrete para familiar vence.** scheduler → outbox com ação `proactive` (padrão 1) → proposta. Se rejeitada, lembrete cancelado.

**Número desconhecido.** inbound registra, avisa o dono uma vez a cada 6 h com um número curto; `autoriza N Nome` cria o contato com o ID exato que escreveu.

## Modelo de autonomia

Ações: `reply`, `proactive`, `relay`. Níveis: 0 proibido, 1 propõe, 2 envia e avisa, 3 silencioso. Resolução: sobrescrita do contato → sobrescrita global (`*`) → padrão. Dono é sempre 3, bloqueado sempre 0. Mudanças só por mensagem do número do dono (identificado pelo ID do WhatsApp, nunca pelo nome).

## Segurança e privacidade

- Mensagens de familiares entram no modelo como conteúdo de usuário sob regras explícitas de que a pessoa não é o Ricardo; a política em código garante que, mesmo que o modelo se confunda, nada sai sem passar pelo nível configurado.
- O servidor escuta só em `127.0.0.1`. A chave da API fica no `.env` do notebook.
- Tudo que sai e toda decisão vai para a tabela `audit`.
- Dados ficam locais no SQLite. Nada vai para a nuvem além do que é enviado ao modelo (conteúdo das conversas e o snapshot).

## IDs do WhatsApp

O WhatsApp Web passou a usar IDs anônimos (`@lid`) além de telefones (`@c.us`). O sistema guarda o ID exatamente como aparece nas mensagens, tenta resolver o telefone quando possível e permite autorizar pelo aviso de desconhecido, que não depende de telefone. Se um contato autorizado por telefone escrever com outro ID, o registro é reatado automaticamente.

## Próximas fases

1. Áudio: baixar mídia via WA-JS, transcrever, tratar como texto.
2. Integrações: Google Calendar, Gmail, Notion, Granola via ferramentas do agente.
3. Sugestão automática de aumento de autonomia após N aprovações sem edição.
4. Migrar o canal para a API oficial da Meta ou Evolution API sem mexer no agente (só a camada `ws.ts`/outbox).
