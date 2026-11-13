import { randomUUID } from "node:crypto";

import { errorCode, errorMessage, HubError } from "./errors.js";
import { encodeMessage, isOpName, parseChunkedResult, parseMessage, type OpName, type ResultMessage } from "./protocol.js";

export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface MachineInfo {
  name: string;
  connectedAt: number;
  api?: "v1" | "v2";
  version?: string;
}

interface MachineConn {
  socket: SocketLike;
  connectedAt: number;
  api?: "v1" | "v2";
  version?: string;
}

interface Pending {
  machine: string;
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ChunkBuf {
  parts: number;
  pieces: Array<string | undefined>;
  got: number;
}

export interface RelayHubOptions {
  callTimeoutMs?: number;
  maxInFlight?: number;
  now?: () => number;
}

/**
 * In-memory router from machine name to outbound agent socket.
 * The Cloudflare Durable Object and the unit tests both use this class.
 * Socket identity is the object passed to attach/detach, so wrappers must be stable.
 */
export class RelayHub {
  private readonly machines = new Map<string, MachineConn>();
  private readonly pending = new Map<string, Pending>();
  private readonly chunks = new Map<string, ChunkBuf>();
  private readonly callTimeoutMs: number;
  private readonly maxInFlight: number;
  private readonly now: () => number;

  constructor(options: RelayHubOptions = {}) {
    this.callTimeoutMs = options.callTimeoutMs ?? 20_000;
    this.maxInFlight = options.maxInFlight ?? 32;
    this.now = options.now ?? Date.now;
  }

  attach(name: string, socket: SocketLike, meta: { api?: "v1" | "v2"; version?: string } = {}): void {
    const prev = this.machines.get(name);
    if (prev && prev.socket !== socket) {
      this.rejectPending(name, new HubError(`Machine ${name} reconnected.`, "machine_reconnected"));
      try {
        prev.socket.close(4001, "replaced");
      } catch {
        /* already closed */
      }
    }
    this.machines.set(name, {
      socket,
      connectedAt: this.now(),
      api: meta.api ?? prev?.api,
      version: meta.version ?? prev?.version,
    });
  }

  detach(name: string, socket: SocketLike): void {
    const current = this.machines.get(name);
    if (!current || current.socket !== socket) return;
    this.machines.delete(name);
    this.rejectPending(name, new HubError(`Machine ${name} disconnected.`, "machine_offline"));
  }

  updateMeta(name: string, meta: { api?: "v1" | "v2"; version?: string }): void {
    const current = this.machines.get(name);
    if (!current) return;
    if (meta.api) current.api = meta.api;
    if (meta.version) current.version = meta.version;
  }

  list(): MachineInfo[] {
    return [...this.machines.entries()].map(([name, conn]) => ({
      name,
      connectedAt: conn.connectedAt,
      ...(conn.api ? { api: conn.api } : {}),
      ...(conn.version ? { version: conn.version } : {}),
    }));
  }

  has(name: string): boolean {
    return this.machines.has(name);
  }

  handleSocketMessage(name: string, raw: string): void {
    const conn = this.machines.get(name);
    if (!conn) return;
    let message;
    try {
      message = parseMessage(raw);
    } catch (err) {
      const id = peekFrameId(raw);
      if (!id) return;
      const pending = this.pending.get(id);
      if (!pending || pending.machine !== name) return;
      this.fail(id, new HubError(errorMessage(err), errorCode(err) === "error" ? "bad_frame" : errorCode(err)));
      return;
    }
    if (message.type === "ping") {
      try {
        conn.socket.send(encodeMessage({ type: "pong", t: message.t }));
      } catch {
        /* socket closing */
      }
      return;
    }
    if (message.type === "hello") {
      this.updateMeta(name, {
        api: message.opencode?.api,
        version: message.opencode?.version,
      });
      return;
    }
    if (message.type === "result") {
      const pending = this.pending.get(message.id);
      if (!pending || pending.machine !== name) return;
      if (!message.ok) {
        this.fail(message.id, new HubError(message.error.message, message.error.code));
        return;
      }
      if (typeof message.part === "number" || typeof message.parts === "number") {
        this.acceptChunk(pending, message);
        return;
      }
      this.pending.delete(message.id);
      this.chunks.delete(message.id);
      clearTimeout(pending.timer);
      pending.resolve(message.data);
    }
  }

  call(machine: string, op: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (!isOpName(op)) return Promise.reject(new HubError(`Unknown op ${op}.`, "unknown_op"));
    const conn = this.machines.get(machine);
    if (!conn) return Promise.reject(new HubError(`Machine ${machine} is not connected.`, "machine_offline"));
    const inFlight = [...this.pending.values()].filter((item) => item.machine === machine).length;
    if (inFlight >= this.maxInFlight) {
      return Promise.reject(new HubError(`Too many in-flight calls to ${machine}.`, "busy"));
    }
    const id = randomUUID();
    const timeout = timeoutMs ?? this.callTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.chunks.delete(id);
        reject(new HubError(`Call to ${machine} timed out after ${timeout}ms.`, "timeout"));
      }, timeout);
      this.pending.set(id, { machine, resolve, reject, timer });
      try {
        conn.socket.send(
          encodeMessage({
            type: "rpc",
            id,
            op: op as OpName,
            params: params ?? {},
          }),
        );
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new HubError(errorMessage(err), errorCode(err)));
      }
    });
  }

  private acceptChunk(pending: Pending, message: ResultMessage): void {
    const part = message.part;
    const parts = message.parts;
    if (
      typeof part !== "number" ||
      typeof parts !== "number" ||
      !Number.isInteger(part) ||
      !Number.isInteger(parts) ||
      parts < 1 ||
      part < 0 ||
      part >= parts ||
      typeof message.data !== "string"
    ) {
      this.fail(message.id, new HubError("Invalid relay result chunk.", "bad_frame"));
      return;
    }
    let buf = this.chunks.get(message.id);
    if (!buf) {
      buf = { parts, pieces: new Array(parts), got: 0 };
      this.chunks.set(message.id, buf);
    }
    if (buf.parts !== parts) {
      this.fail(message.id, new HubError("Relay result chunk count changed.", "bad_frame"));
      return;
    }
    if (buf.pieces[part] === undefined) {
      buf.pieces[part] = message.data;
      buf.got += 1;
    }
    if (buf.got !== buf.parts) return;
    try {
      const data = parseChunkedResult(buf.pieces);
      this.pending.delete(message.id);
      this.chunks.delete(message.id);
      clearTimeout(pending.timer);
      pending.resolve(data);
    } catch (err) {
      this.fail(message.id, new HubError(errorMessage(err), errorCode(err)));
    }
  }

  private fail(id: string, err: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    this.chunks.delete(id);
    pending.reject(err);
  }

  private rejectPending(machine: string, err: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.machine !== machine) continue;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      this.chunks.delete(id);
      pending.reject(err);
    }
  }
}

function peekFrameId(raw: string): string | undefined {
  const head = raw.length > 800 ? raw.slice(0, 800) : raw;
  const match = /"id"\s*:\s*"([^"\\]{1,80})"/.exec(head);
  return match?.[1];
}
