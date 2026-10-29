// Минимальный JSON-RPC клиент к codex app-server через /ws/codex.
// Типы протокола: `codex app-server generate-ts` (здесь берём только нужные поля).

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };
export type ServerRequest = { id: number | string; method: string; params: any };

export class CodexClient {
  private ws?: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor(
    private onNotification: (method: string, params: any) => void,
    private onServerRequest: (req: ServerRequest) => void,
    private onClose: () => void,
  ) {}

  async connect() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws/codex`);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("websocket error"));
    });
    ws.onmessage = (e) => this.dispatch(JSON.parse(String(e.data)));
    ws.onclose = () => {
      for (const p of this.pending.values()) p.reject(new Error("connection closed"));
      this.pending.clear();
      this.onClose();
    };
    await this.request("initialize", {
      clientInfo: { name: "paddock-web", title: "Paddock", version: "0.1.0" },
      capabilities: null,
    });
    this.send({ method: "initialized" });
  }

  request<T = any>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }

  respond(id: number | string, result: unknown) {
    this.send({ id, result });
  }

  close() {
    this.ws?.close();
  }

  private send(msg: object) {
    this.ws?.send(JSON.stringify(msg));
  }

  private dispatch(msg: any) {
    if (msg.id !== undefined && msg.method) return this.onServerRequest(msg);
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method) this.onNotification(msg.method, msg.params);
  }
}
