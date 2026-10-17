# Aia · secretária pessoal no WhatsApp

Protótipo de uma secretária com IA que vive num **número de WhatsApp Business próprio**, lê e responde mensagens pelo **WhatsApp Web** num notebook dedicado, mantém a lista de pendências do Ricardo e dos familiares, e **consulta o Ricardo antes de falar com terceiros**, com autonomia liberada aos poucos.

Três peças, todas rodando no notebook (Windows):

| Peça | Onde | Função |
|---|---|---|
| `extension/` | Chrome (modo desenvolvedor) | Olhos e mãos. Injeta a biblioteca WA-JS no WhatsApp Web e repassa mensagens para o servidor local. Nada de IA aqui. |
| `server/` | Node.js em `127.0.0.1:8787` | Cérebro e memória. Agente Claude com ferramentas, banco SQLite, política de autonomia, lembretes e resumo diário. |
| Claude API | nuvem da Anthropic | Só o raciocínio. O servidor manda contexto e recebe decisões. |

Documento de arquitetura e decisões: [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md).

---

## Instalação no notebook dedicado (Windows)

### 1. Pré-requisitos

1. **Node.js 22.13 ou superior** (recomendado: 24 LTS): https://nodejs.org → instalador Windows, opções padrão. Confira num novo terminal: `node --version`.
2. **Chrome** com o WhatsApp Web (`https://web.whatsapp.com`) já logado na conta da Aia.
3. **Chave da API da Anthropic**: https://console.anthropic.com → *API Keys* → *Create key*. Coloque créditos pré-pagos (US$ 5 bastam por semanas). É diferente do login do claude.ai: o servidor precisa da chave para chamar o modelo por programa.

### 2. Baixar o projeto

Com Git: `git clone <este repositório>` e entre na pasta `aia`. Sem Git: baixe o ZIP do repositório no GitHub e extraia.

### 3. Configurar e subir o servidor

Abra o PowerShell na pasta `aia\server`:

```powershell
npm install
copy .env.example .env
notepad .env        # cole a ANTHROPIC_API_KEY e salve
npm run build
npm start
```

Deve aparecer algo como:

```
[main] Aia servidor em http://127.0.0.1:8787/
[main] >>> Dono ainda não pareado. Do seu WhatsApp pessoal, mande para a Aia: "pareia 123456"
```

Deixe essa janela aberta. Abra http://127.0.0.1:8787/ no navegador para ver o painel.

### 4. Instalar a extensão no Chrome

1. Chrome → `chrome://extensions` → ligue **Modo do desenvolvedor** (canto superior direito).
2. **Carregar sem compactação** → escolha a pasta `aia\extension`.
3. Recarregue a aba do WhatsApp Web (F5). O ícone da Aia na barra deve mostrar **ON** em verde. Se mostrar **WA** ou **SRV**, só uma das duas pontas está conectada; **OFF** é nenhuma.

### 5. Parear o seu número

Do **seu** WhatsApp pessoal, mande para o número da Aia: `pareia 123456` (o código que aparece no terminal e no painel). Ela responde com a lista de comandos. A partir daí só o seu número manda nela.

Alternativa: preencha `OWNER_PHONE` no `.env` (só dígitos, com 55) e ela te reconhece na primeira mensagem, quando o WhatsApp expõe o telefone do remetente.

### 6. Autorizar os familiares

Qualquer um dos três:

- Encaminhe o **cartão de contato** da pessoa para a Aia (no WhatsApp: anexar → Contato).
- Mande `autoriza 5551999998888 Mãe`.
- Espere a pessoa escrever para a Aia: você recebe um aviso "Número desconhecido #1" e responde `autoriza 1 Mãe`.

Todo familiar começa no modo mais cauteloso: a Aia **pede seu ok** antes de qualquer resposta ou iniciativa.

### 7. Deixar ligado sozinho

- **Energia**: Configurações → Sistema → Energia → "Suspender" = Nunca (na tomada). Pode desligar só a tela.
- **Servidor no boot**: crie um atalho para `aia\server\start-aia.cmd` e coloque na pasta que abre com `Win + R` → `shell:startup`.
- **Chrome no boot**: coloque também um atalho do Chrome na mesma pasta, com destino `chrome.exe https://web.whatsapp.com`. Nas configurações do Chrome, em *Sistema*, deixe ligado "Continuar executando apps em segundo plano".
- **Celular da Aia**: precisa ficar ligado e com internet de vez em quando. O WhatsApp Web desconecta se o celular passar ~14 dias offline.

Teste a resiliência: feche a aba, reabra, veja o badge voltar a ON. Pare o servidor (`Ctrl+C`), suba de novo, veja o badge voltar.

---

## Como usar

Fale em linguagem natural com a Aia pelo seu WhatsApp. Exemplos:

- `anota: ligar pro contador até sexta`
- `o que tenho pendente?` · `feito 3`
- `me lembra amanhã às 9 de mandar o relatório`
- `tarefa para a mãe: levar o exame na quinta, com lembrete`
- `avisa a mãe que chego às 20h` → por padrão ela envia e te avisa (recado seu é nível 2)
- `lembra a mãe amanhã às 9 do exame` → iniciativa dela: vira proposta para seu ok
- `pode responder a mãe sem me perguntar` → sobe a autonomia de resposta para nível 3
- `volta a me perguntar antes de responder a mãe` → desce para nível 1

Atalhos fixos (sem IA, funcionam sempre): `ajuda`, `status`, `pendentes`, `contatos`, `pausa`, `retoma`, `autoriza N Nome`, `ignora N`.

### Propostas

Quando a Aia quer mandar algo que a política não libera sozinha, você recebe:

```
📝 Proposta #12 → Mãe (responder)
"Oi! O Ricardo está em reunião, mas passo o recado."
Motivo: respondendo a: "ele pode falar agora?"
Responda: ok 12 · não 12 · 12: novo texto
```

Também funciona responder **citando** a proposta no WhatsApp: `ok`, `não`, ou direto o texto corrigido. Proposta sem resposta expira em 6 horas (`PROPOSAL_TTL_HOURS`).

### Níveis de autonomia

| Nível | Comportamento |
|---|---|
| 0 | proibido |
| 1 | propõe e espera seu ok (**padrão** para responder e para iniciativa própria) |
| 2 | envia e te avisa (**padrão** para recados que você pediu) |
| 3 | envia em silêncio, só registra |

Três ações: **responder** a um familiar, **iniciativa própria** (lembrete, cobrança) e **recado seu**. Ajuste por contato ou para todos, em linguagem natural ou com a ferramenta `set_autonomy`. A permissão é aplicada no código do servidor, não no prompt: um familiar não consegue "convencer" a Aia a pular a aprovação.

### O que a Aia faz com um familiar

Responde cordialmente, informa **as tarefas e lembretes daquela pessoa**, marca tarefa dela como feita, anota recado para você. Não revela sua agenda, localização ou trabalho, não aceita ordens sobre o sistema e não promete nada em seu nome.

### Resumo diário

Todo dia às 17:00 (`DIGEST_TIME`) você recebe atrasadas, próximas 24h, demais pendências, pendências de familiares, lembretes e propostas em aberto.

---

## Operação e diagnóstico

- Painel: http://127.0.0.1:8787/ (atualiza sozinho) · JSON em `/health`.
- Log do servidor: a janela do `npm start`. Toda mensagem enviada, proposta e decisão fica na tabela `audit` do SQLite (`server\data\aia.sqlite`).
- Console da página do WhatsApp Web (F12): mensagens `[Aia/page]`. Console do service worker: `chrome://extensions` → Aia → *service worker*.
- Mudar modelo ou esforço: `AIA_MODEL`, `AIA_EFFORT` no `.env`. Padrão `claude-opus-5-5` com esforço `medium`.
- Testes: `npm test` na pasta `server` (não precisa de chave da API).

## Limitações desta versão

- Só texto. Áudio, imagem e documentos são reconhecidos mas não interpretados.
- Só conversas individuais. Grupos são ignorados.
- Depende do notebook ligado, com Chrome e WhatsApp Web abertos. Se o WhatsApp Web cair, a Aia não tem como te avisar por WhatsApp; olhe o badge ou o painel.
- Automação do WhatsApp Web contraria os termos de uso do WhatsApp. O risco é de banimento **do número da Aia**. Volume baixo, só com familiares, reduz o risco. Nunca aponte isto para o seu número pessoal.
- A biblioteca WA-JS acompanha as mudanças do WhatsApp Web; se algo quebrar, atualize `extension/vendor/wppconnect-wa.js` com a versão mais nova de https://github.com/wppconnect-team/wa-js/releases.
