function mark(id, ok, label) {
  const el = document.getElementById(id);
  el.textContent = label || (ok ? 'conectado' : 'desconectado');
  el.className = ok ? 'ok' : 'bad';
}
chrome.runtime.sendMessage({ type: 'aia:status' }, (s) => {
  if (!s) { mark('srv', false); mark('wa', false); return; }
  mark('srv', s.wsReady);
  mark('wa', s.pageReady);
  const me = document.getElementById('me');
  me.textContent = s.me ? s.me.replace(/@.*/, '') : '—';
});
