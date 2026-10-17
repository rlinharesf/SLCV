/*
 * Aia - ponte entre a página (mundo MAIN) e o service worker da extensão.
 * Só repassa mensagens; não tem lógica de negócio.
 */
(() => {
  const TAG = '[Aia/bridge]';
  let port = null;
  let pending = [];

  function connectPort() {
    try {
      port = chrome.runtime.connect({ name: 'aia-page' });
    } catch (e) {
      console.warn(TAG, 'não consegui conectar ao service worker', e);
      port = null;
      setTimeout(connectPort, 2000);
      return;
    }
    port.onMessage.addListener((msg) => {
      // extensão -> página
      window.postMessage({ __aia: 'ext', ...msg }, '*');
    });
    port.onDisconnect.addListener(() => {
      port = null;
      setTimeout(connectPort, 1000);
    });
    // Descarrega a fila acumulada enquanto estava desconectado.
    const queue = pending;
    pending = [];
    for (const m of queue) safePost(m);
    // Pede o estado atual à página para o service worker atualizar o badge.
    window.postMessage({ __aia: 'ext', type: 'cmd', cmd: { op: 'ping', reqId: 'bridge-ping-' + Date.now() } }, '*');
  }

  function safePost(msg) {
    if (!port) {
      pending.push(msg);
      if (pending.length > 200) pending.shift();
      return;
    }
    try {
      port.postMessage(msg);
    } catch (e) {
      pending.push(msg);
      port = null;
      setTimeout(connectPort, 1000);
    }
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__aia !== 'page') return;
    const { __aia, ...rest } = d;
    safePost(rest);
  });

  connectPort();
})();
