/*
 * Aia - script que roda DENTRO da página do WhatsApp Web (mundo MAIN).
 * Usa a biblioteca WA-JS (window.WPP) para receber mensagens e enviar respostas,
 * sem depender do HTML da página.
 *
 * Comunicação com a extensão: window.postMessage com a marca `__aia`.
 *   página -> extensão: { __aia: 'page', type: 'ready' | 'message' | 'result' | 'state', ... }
 *   extensão -> página: { __aia: 'ext',  type: 'cmd', cmd: { op, reqId, ... } }
 */
(() => {
  const TAG = '[Aia/page]';
  const state = { ready: false, me: null, started: Date.now() };

  function post(payload) {
    try {
      window.postMessage({ __aia: 'page', ...payload }, '*');
    } catch (e) {
      console.warn(TAG, 'postMessage falhou', e);
    }
  }

  function serialized(wid) {
    if (!wid) return undefined;
    if (typeof wid === 'string') return wid;
    return wid._serialized || (typeof wid.toString === 'function' ? wid.toString() : undefined);
  }

  function digits(str) {
    return (str || '').replace(/\D/g, '');
  }

  // Tenta descobrir o telefone do remetente. Com os IDs novos do WhatsApp (@lid)
  // nem sempre dá; o servidor tem um mecanismo de autorização que não depende disso.
  function resolvePhone(msg) {
    const candidates = [];
    try {
      const from = serialized(msg.from);
      if (from && from.endsWith('@c.us')) candidates.push(from);
      const author = serialized(msg.author);
      if (author && author.endsWith('@c.us')) candidates.push(author);
      const so = msg.senderObj;
      if (so) {
        candidates.push(serialized(so.phoneNumber));
        const soId = serialized(so.id);
        if (soId && soId.endsWith('@c.us')) candidates.push(soId);
      }
      if (window.WPP && WPP.contact && typeof WPP.contact.get === 'function') {
        const c = WPP.contact.get(msg.from);
        if (c) {
          candidates.push(serialized(c.phoneNumber));
          const cid = serialized(c.id);
          if (cid && cid.endsWith('@c.us')) candidates.push(cid);
        }
      }
    } catch (e) {
      /* ignora */
    }
    for (const c of candidates) {
      const d = digits(c);
      if (d.length >= 8) return d;
    }
    return undefined;
  }

  function extractVcards(msg) {
    try {
      if (msg.type === 'vcard') return msg.body ? [String(msg.body)] : [];
      if (msg.type === 'multi_vcard') {
        const list = msg.vcardList || [];
        return list.map((v) => (typeof v === 'string' ? v : v.vcard || '')).filter(Boolean);
      }
    } catch (e) {
      /* ignora */
    }
    return [];
  }

  function serializeMessage(msg) {
    const chatId = serialized(msg.id && msg.id.remote) || serialized(msg.from);
    const fromMe = !!(msg.id && msg.id.fromMe);
    let name;
    try {
      name = msg.notifyName || (msg.senderObj && (msg.senderObj.pushname || msg.senderObj.name || msg.senderObj.formattedName));
    } catch (e) {
      /* ignora */
    }
    return {
      id: serialized(msg.id) || String(msg.id),
      fromMe,
      chatId,
      from: serialized(msg.from),
      to: serialized(msg.to),
      author: serialized(msg.author),
      isGroup: !!msg.isGroupMsg || /@g\.us$/.test(chatId || ''),
      type: msg.type,
      body: msg.body || msg.caption || '',
      t: msg.t,
      notifyName: name,
      senderPhone: fromMe ? undefined : resolvePhone(msg),
      quotedMsgId: serialized(msg.quotedMsgId) || msg.quotedStanzaID || undefined,
      vcards: extractVcards(msg),
    };
  }

  async function handleCommand(cmd) {
    const reqId = cmd.reqId;
    try {
      if (cmd.op === 'ping') {
        post({ type: 'result', reqId, ok: true, state: currentState() });
        return;
      }
      if (!state.ready) throw new Error('whatsapp_not_ready');

      if (cmd.op === 'send') {
        const to = cmd.to;
        const text = String(cmd.text || '');
        if (!to || !text) throw new Error('missing_to_or_text');
        try {
          // Mostra "digitando..." por um tempo proporcional ao tamanho do texto.
          const ms = Math.min(6000, 800 + text.length * 25);
          await WPP.chat.markIsComposing(to, ms);
          await new Promise((r) => setTimeout(r, ms));
        } catch (e) {
          /* opcional */
        }
        const opts = { createChat: true };
        if (cmd.quotedMsgId) opts.quotedMsg = cmd.quotedMsgId;
        const res = await WPP.chat.sendTextMessage(to, text, opts);
        const msgId = res && (serialized(res.id) || (res.id && res.id._serialized) || String(res.id));
        post({ type: 'result', reqId, ok: true, msgId });
        return;
      }

      if (cmd.op === 'markRead') {
        try {
          await WPP.chat.markIsRead(cmd.chatId);
        } catch (e) {
          /* ignora */
        }
        post({ type: 'result', reqId, ok: true });
        return;
      }

      if (cmd.op === 'resolve') {
        // Descobre o(s) ID(s) de WhatsApp de um telefone.
        const phone = digits(cmd.phone);
        let wid, lid, exists = false;
        try {
          const r = await WPP.contact.queryExists(phone);
          if (r) {
            exists = true;
            wid = serialized(r.wid);
            lid = serialized(r.lid);
          }
        } catch (e) {
          /* ignora */
        }
        post({ type: 'result', reqId, ok: true, exists, wid, lid, phone });
        return;
      }

      throw new Error('unknown_op:' + cmd.op);
    } catch (e) {
      post({ type: 'result', reqId, ok: false, error: String((e && e.message) || e) });
    }
  }

  function currentState() {
    let authenticated = null;
    try {
      authenticated = WPP.conn.isAuthenticated();
    } catch (e) {
      /* ignora */
    }
    return { ready: state.ready, me: state.me, authenticated, uptimeMs: Date.now() - state.started };
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__aia !== 'ext') return;
    if (d.type === 'cmd' && d.cmd) handleCommand(d.cmd);
  });

  function onReady() {
    if (state.ready) return;
    state.ready = true;
    try {
      state.me = serialized(WPP.conn.getMyUserId());
    } catch (e) {
      /* ignora */
    }
    console.log(TAG, 'WA-JS pronto. Eu sou', state.me);

    WPP.on('chat.new_message', (msg) => {
      try {
        const payload = serializeMessage(msg);
        post({ type: 'message', message: payload });
      } catch (e) {
        console.warn(TAG, 'falha ao serializar mensagem', e);
      }
    });

    // Reenvia o estado quando a conexão muda (útil para o badge da extensão).
    for (const evName of ['conn.authenticated', 'conn.logout', 'conn.main_ready', 'conn.require_auth']) {
      try {
        WPP.on(evName, () => post({ type: 'state', state: currentState(), event: evName }));
      } catch (e) {
        /* ignora */
      }
    }

    post({ type: 'ready', state: currentState() });
  }

  function waitForWpp() {
    if (window.WPP && WPP.webpack) {
      try {
        if (typeof WPP.webpack.onFullReady === 'function') {
          WPP.webpack.onFullReady(onReady);
        } else if (typeof WPP.webpack.onReady === 'function') {
          WPP.webpack.onReady(onReady);
        }
        if (WPP.webpack.isFullReady || WPP.webpack.isReady) onReady();
      } catch (e) {
        console.warn(TAG, 'erro ao registrar onReady', e);
      }
      // Poll de segurança: se o evento não vier, verifica a flag periodicamente.
      const poll = setInterval(() => {
        if (state.ready) return clearInterval(poll);
        try {
          if (WPP.webpack.isFullReady) onReady();
        } catch (e) {
          /* ignora */
        }
      }, 2000);
      return;
    }
    setTimeout(waitForWpp, 300);
  }

  console.log(TAG, 'carregado');
  waitForWpp();
})();
