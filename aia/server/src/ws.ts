import http from "node:http";
import { EventEmitter } from "node:events";
import { WebSocketServer, WebSocket } from "ws";
import { log, warn } from "./log.js";

/** Mensagem recebida do WhatsApp Web, já serializada pela extensão (page.js). */
export interface InboundMessage {
  id: string;
  fromMe: boolean;
  chatId: string;
  from?: string;
  to?: string;
  author?: string;
  isGroup: boolean;
  type: string;
  body: string;
  t?: number;
  notifyName?: string;
  senderPhone?: string;
  quotedMsgId?: string;
  vcards: string[];
}

export interface PageState {
  ready: boolean;
  me?: string | null;
  authenticated?: boolean | null;
}

interface PendingReq {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export interface SendResult {
  ok: boolean;
  msgId?: string;
  error?: string;
}

/**
 * Ponte com a extensão do Chrome. Um único cliente por vez (a extensão).
 * Eventos: 'message' (InboundMessage), 'ready' (PageState), 'disconnect'.
 */
export class ExtensionBridge extends EventEmitter {
  private wss: WebSocketServer;
  private client: WebSocket | null = null;
  private pending = new Map<string, PendingReq>();
  private seq = 0;
  pageState: PageState = { ready: false, me: null };
  lastSeen = 0;
  statusHtml: () => string = () => "<p>sem status</p>";
  statusJson: () => Record<string, unknown> = () => ({});

  constructor(private server: http.Server) {
    super();
    this.wss = new WebSocketServer({ server, path: "/ext" });
    this.wss.on("connection", (ws) => this.onConnection(ws));
    setInterval(() => {
      if (this.client && this.client.readyState === WebSocket.OPEN) {
        try {
          this.client.send(JSON.stringify({ type: "ping", t: Date.now() }));
        } catch {
          /* ignora */
        }
      }
    }, 20000).unref();
  }

  get connected(): boolean {
    return !!this.client && this.client.readyState === WebSocket.OPEN;
  }

  private onConnection(ws: WebSocket): void {
    if (this.client && this.client !== ws) {
      try {
        this.client.close();
      } catch {
        /* ignora */
      }
    }
    this.client = ws;
    this.lastSeen = Date.now();
    log("ws", "extensão conectada");
    ws.on("message", (raw) => {
      this.lastSeen = Date.now();
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(String(raw));
      } catch {
        return;
      }
      this.handle(data);
    });
    ws.on("close", () => {
      if (this.client === ws) {
        this.client = null;
        this.pageState = { ready: false, me: null };
        log("ws", "extensão desconectada");
        this.emit("disconnect");
      }
    });
    ws.on("error", (e) => warn("ws", "erro no socket", e.message));
  }

  private handle(data: Record<string, unknown>): void {
    const type = data.type;
    if (type === "hello" || type === "hb" || type === "pong") {
      const ps = data.pageState as PageState | undefined;
      if (ps) this.updateState(ps);
      return;
    }
    if (type === "ready" || type === "state") {
      const st = data.state as PageState | undefined;
      if (st) this.updateState(st);
      return;
    }
    if (type === "message") {
      const m = data.message as InboundMessage | undefined;
      if (m && m.id) this.emit("message", m);
      return;
    }
    if (type === "result") {
      const reqId = String(data.reqId ?? "");
      const p = this.pending.get(reqId);
      if (!p) return;
      this.pending.delete(reqId);
      clearTimeout(p.timer);
      p.resolve(data);
      return;
    }
  }

  private updateState(st: PageState): void {
    const wasReady = this.pageState.ready;
    this.pageState = { ready: !!st.ready, me: st.me ?? this.pageState.me, authenticated: st.authenticated };
    if (!wasReady && this.pageState.ready) {
      log("ws", "WhatsApp Web pronto; conta", this.pageState.me);
      this.emit("ready", this.pageState);
    }
  }

  /** Envia um comando para a página e espera o resultado. */
  private request(cmd: Record<string, unknown>, timeoutMs = 30000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (!this.connected) return reject(new Error("extension_not_connected"));
      const reqId = `r${Date.now()}-${++this.seq}`;
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error("timeout"));
      }, timeoutMs);
      this.pending.set(reqId, { resolve, reject, timer });
      try {
        this.client!.send(JSON.stringify({ type: "cmd", cmd: { ...cmd, reqId } }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(reqId);
        reject(e as Error);
      }
    });
  }

  async sendText(to: string, text: string, quotedMsgId?: string): Promise<SendResult> {
    try {
      const r = await this.request({ op: "send", to, text, quotedMsgId });
      if (r.ok) return { ok: true, msgId: r.msgId ? String(r.msgId) : undefined };
      return { ok: false, error: String(r.error ?? "unknown") };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  async markRead(chatId: string): Promise<void> {
    try {
      await this.request({ op: "markRead", chatId }, 10000);
    } catch {
      /* não é crítico */
    }
  }

  async resolvePhone(phone: string): Promise<{ exists: boolean; wid?: string; lid?: string }> {
    try {
      const r = await this.request({ op: "resolve", phone }, 15000);
      return { exists: !!r.exists, wid: r.wid ? String(r.wid) : undefined, lid: r.lid ? String(r.lid) : undefined };
    } catch {
      return { exists: false };
    }
  }
}

/** Servidor HTTP com painel de status + WebSocket da extensão. */
export function createHttpServer(): http.Server {
  const server = http.createServer();
  return server;
}

export function attachStatusRoutes(server: http.Server, bridge: ExtensionBridge): void {
  server.on("request", (req, res) => {
    const url = req.url ?? "/";
    if (url.startsWith("/health")) {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(bridge.statusJson(), null, 2));
      return;
    }
    if (url === "/" || url.startsWith("/index")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(bridge.statusHtml());
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
}
