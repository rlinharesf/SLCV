/*
 * Aia - service worker da extensão.
 * Mantém um WebSocket com o servidor local (ws://127.0.0.1:8787/ext) e repassa
 * mensagens entre o servidor e a aba do WhatsApp Web.
 */
const DEFAULT_SERVER = 'ws://127.0.0.1:8787/ext';
const TAG = '[Aia/bg]';

let ws = null;
let wsReady = false;
let pagePort = null;
let pageState = { ready: false, me: null };
let reconnectDelay = 1000;
let hbTimer = null;
const pendingResults = new Map(); // reqId -> true (só para diagnóstico)

async function serverUrl() {
  try {
    const { serverUrl } = await chrome.storage.local.get('serverUrl');
    return serverUrl || DEFAULT_SERVER;
  } catch (e) {
    return DEFAULT_SERVER;
  }
}

function setBadge() {
  let text = 'OFF', color = '#c0392b';
  if (wsReady && pageState.ready) { text = 'ON'; color = '#27ae60'; }
  else if (pageState.ready) { text = 'WA'; color = '#f39c12'; }
  else if (wsReady) { text = 'SRV'; color = '#f39c12'; }
  try {
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color });
  } catch (e) { /* ignora */ }
  chrome.storage.session?.set({ status: { wsReady, pageReady: pageState.ready, me: pageState.me, at: Date.now() } }).catch?.(() => {});
}

function wsSend(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try { ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
}

async function connectWs() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const url = await serverUrl();
  try {
    ws = new WebSocket(url);
  } catch (e) {
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    wsReady = true;
    reconnectDelay = 1000;
    console.log(TAG, 'conectado ao servidor', url);
    wsSend({ type: 'hello', client: 'aia-extension', version: chrome.runtime.getManifest().version, pageState });
    if (hbTimer) clearInterval(hbTimer);
    hbTimer = setInterval(() => wsSend({ type: 'hb', pageState, t: Date.now() }), 20000);
    setBadge();
  };
  ws.onmessage = (ev) => {
    let data;
    try { data = JSON.parse(ev.data); } catch (e) { return; }
    if (data.type === 'cmd') {
      if (!pagePort) {
        wsSend({ type: 'result', reqId: data.cmd?.reqId, ok: false, error: 'page_not_connected' });
        return;
      }
      try {
        pendingResults.set(data.cmd?.reqId, true);
        pagePort.postMessage({ type: 'cmd', cmd: data.cmd });
      } catch (e) {
        wsSend({ type: 'result', reqId: data.cmd?.reqId, ok: false, error: 'page_post_failed' });
      }
    } else if (data.type === 'ping') {
      wsSend({ type: 'pong', t: Date.now(), pageState });
    }
  };
  ws.onclose = () => {
    wsReady = false;
    if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
    setBadge();
    scheduleReconnect();
  };
  ws.onerror = () => { /* onclose cuida */ };
}

function scheduleReconnect() {
  setTimeout(connectWs, reconnectDelay);
  reconnectDelay = Math.min(30000, reconnectDelay * 2);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'aia-page') return;
  pagePort = port;
  console.log(TAG, 'aba do WhatsApp conectada');
  port.onMessage.addListener((msg) => {
    if (msg.type === 'ready' || msg.type === 'state') {
      pageState = { ready: !!(msg.state && msg.state.ready), me: msg.state && msg.state.me };
      setBadge();
      wsSend({ type: msg.type, state: msg.state, event: msg.event });
      return;
    }
    if (msg.type === 'result') {
      if (String(msg.reqId || '').startsWith('bridge-ping-')) {
        if (msg.state) { pageState = { ready: !!msg.state.ready, me: msg.state.me }; setBadge(); }
        return;
      }
      pendingResults.delete(msg.reqId);
      wsSend(msg);
      return;
    }
    if (msg.type === 'message') {
      const ok = wsSend(msg);
      if (!ok) console.warn(TAG, 'servidor offline; mensagem descartada', msg.message && msg.message.id);
      return;
    }
  });
  port.onDisconnect.addListener(() => {
    if (pagePort === port) pagePort = null;
    pageState = { ready: false, me: null };
    setBadge();
    wsSend({ type: 'state', state: { ready: false } });
  });
  connectWs();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'aia:status') {
    sendResponse({ wsReady, pageReady: pageState.ready, me: pageState.me });
  }
  return false;
});

// Alarme periódico garante que o service worker acorde e reconecte se preciso.
chrome.alarms.create('aia-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'aia-keepalive') connectWs();
});

chrome.runtime.onInstalled.addListener(() => connectWs());
chrome.runtime.onStartup.addListener(() => connectWs());
connectWs();
setBadge();
