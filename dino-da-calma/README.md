# 🦕 Dino da Calma

Jogo infantil interativo para celular, destinado a crianças de **4 a 6 anos**, que estimula
**autocontrole, regulação emocional, atenção, tolerância à frustração e esperar a vez** —
com a ajuda do Dino, um dinossauro simpático e expressivo.

## Como jogar

É um aplicativo web: basta abrir o arquivo **`index.html`** no navegador do celular
(ou hospedar a pasta em qualquer servidor estático, como o GitHub Pages).
Não precisa instalar nada.

## As 6 brincadeiras

| Brincadeira | Habilidade praticada |
|---|---|
| 🚦 **Semáforo dos Dinos** | Verde: toque para andar. Amarelo: prepare-se. Vermelho: pare! Sinais alternam em intervalos imprevisíveis, com dificuldade adaptativa. |
| 🎵 **Dança Congelante** | Dance tocando na tela; quando a música parar, vire estátua com o Dino em poses engraçadas. |
| 🐉 **Respiração do Dragão** | "Cheira a flor… sopra a velinha" — 3 ciclos curtos de respiração guiada, sem prender o ar. |
| 😊 **Emoções do Dino** | Situações reais (perder a corrida, dividir o brinquedo, esperar a vez…): identifique a emoção e escolha uma reação que ajuda. |
| ⏳ **Espera a Vez** | Pequenas esperas com contagem visual antes de pegar o brinquedo, atravessar a ponte ou entrar na brincadeira. |
| 💗 **Dino Ficou Bravo** | Sequência de autorregulação: **parar → respirar → falar o que sente → escolher uma solução** (pedir ajuda, esperar, conversar ou se afastar). |

## Princípios

- **Português brasileiro**, comandos curtos, botões grandes e navegação por ícones —
  utilizável por crianças que ainda não leem.
- **Narração opcional** com a voz do próprio navegador (botão 🔊) — funciona offline.
- **Reforço positivo sempre**: erros são acolhidos ("Tudo bem! Errar faz parte. Vamos de novo?"),
  sem punições, sem competição, sem estímulos acelerados.
- **Dificuldade adaptativa**: os tempos do semáforo, do congelamento e das esperas
  se ajustam ao desempenho da criança.
- **Sessões curtas**: após ~8 minutos o Dino convida para uma pausa e sugere uma
  brincadeira fora da tela.
- **Área dos responsáveis** (protegida por sequência de números): mostra as habilidades
  praticadas e estrelas conquistadas — sem avaliações nem diagnósticos — além de
  sugestões de brincadeiras equivalentes fora da tela.
- **Privacidade total**: sem anúncios, sem compras, sem login, sem coleta de dados,
  sem câmera/microfone e sem serviços externos. O progresso fica salvo apenas no
  próprio aparelho (`localStorage`).

## Tecnologia

Um único arquivo HTML autocontido: personagem em SVG animado via CSS, sons e música
gerados localmente com Web Audio API e narração com a Web Speech API do navegador.
Nenhuma dependência ou requisição de rede.
