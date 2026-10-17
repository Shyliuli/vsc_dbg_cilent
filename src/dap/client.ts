import type { DapEvent, DapResponse } from './protocol.ts';

export type ControlHandler = (event: string, body: any) => void;

export class DapError extends Error {
  readonly command: string;
  readonly dapMessage: string | undefined;

  constructor(command: string, message: string, dapMessage?: string) {
    super(`${command}: ${message}`);
    this.name = 'DapError';
    this.command = command;
    this.dapMessage = dapMessage;
  }
}

interface PendingRequest {
  command: string;
  resolve: (body: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 10_000;
/** gdb implements these requests without sending a DAP response. */
const NO_RESPONSE_COMMANDS = new Set(['next', 'stepIn', 'pause']);

/**
 * DAP client over a browser WebSocket.
 *
 * The Node bridge forwards gdb's DAP JSON verbatim; this class owns message
 * sequencing, request/response correlation and the event stream.
 */
export class DapClient {
  private readonly socket: WebSocket;
  private seq = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly eventListeners = new Map<string, Set<(body: any) => void>>();
  private readonly controlListeners = new Map<string, Set<ControlHandler>>();
  private closeListeners = new Set<(reason: string) => void>();
  private messageListener: ((message: DapResponse | DapEvent) => void) | null = null;
  private closed = false;
  private traceWaiter: ((entries: unknown[]) => void) | null = null;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener('message', (event: MessageEvent) => {
      let message: any;
      try {
        message = JSON.parse(String(event.data));
      } catch (error) {
        console.error('received a non-JSON message from the DAP bridge', error);
        return;
      }
      this.messageListener?.(message);
      if (message.type === 'response') {
        this.handleResponse(message as DapResponse);
      } else if (message.type === 'event') {
        const listeners = this.eventListeners.get(message.event);
        if (listeners) {
          for (const listener of listeners) {
            listener(message.body);
          }
        }
      } else if (message.type === 'control') {
        if (message.event === 'trace' && this.traceWaiter) {
          const waiter = this.traceWaiter;
          this.traceWaiter = null;
          waiter(message.body?.entries ?? []);
          return;
        }
        const listeners = this.controlListeners.get(message.event);
        if (listeners) {
          for (const listener of listeners) {
            listener(message.event, message.body);
          }
        }
      }
    });
    socket.addEventListener('close', () => this.handleClose('connection closed'));
    socket.addEventListener('error', () => this.handleClose('connection error'));
  }

  static async connect(url: string): Promise<DapClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new DapError('connect', `timed out after ${CONNECT_TIMEOUT_MS} ms`));
      }, CONNECT_TIMEOUT_MS);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new DapError('connect', `could not connect to ${url}`));
      });
    });
    return new DapClient(socket);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  onEvent(event: string, listener: (body: any) => void): () => void {
    const listeners = this.eventListeners.get(event) ?? new Set();
    listeners.add(listener);
    this.eventListeners.set(event, listeners);
    return () => listeners.delete(listener);
  }

  onControl(event: string, listener: ControlHandler): () => void {
    const listeners = this.controlListeners.get(event) ?? new Set();
    listeners.add(listener);
    this.controlListeners.set(event, listeners);
    return () => listeners.delete(listener);
  }

  onClose(listener: (reason: string) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /** Resolve on the next matching event. */
  waitEvent(
    event: string,
    predicate: (body: any) => boolean = () => true,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new DapError(event, `timed out waiting for the ${event} event`));
      }, timeoutMs);
      const off = this.onEvent(event, (body) => {
        if (!predicate(body)) {
          return;
        }
        clearTimeout(timer);
        off();
        resolve(body);
      });
    });
  }

  /** Resolve on the next matching transport control message. */
  waitControl(event: string, timeoutMs = CONNECT_TIMEOUT_MS): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new DapError('control', `timed out waiting for the ${event} control message`));
      }, timeoutMs);
      const off = this.onControl(event, (_event, body) => {
        clearTimeout(timer);
        off();
        resolve(body);
      });
    });
  }

  /** Observe every decoded message; used for the protocol trace panel. */
  observeMessages(listener: ((message: DapResponse | DapEvent) => void) | null): void {
    this.messageListener = listener;
  }

  send(command: string, args?: unknown): void {
    if (this.closed) {
      throw new DapError(command, 'the debug session is no longer connected');
    }
    const seq = ++this.seq;
    this.socket.send(JSON.stringify({ seq, type: 'request', command, arguments: args }));
  }

  /** Send a request and resolve with its response body. */
  request<T = any>(command: string, args?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    if (this.closed) {
      return Promise.reject(new DapError(command, 'the debug session is no longer connected'));
    }
    const seq = ++this.seq;
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new DapError(command, `timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(seq, {
        command,
        resolve: resolve as (body: any) => void,
        reject,
        timer,
      });
    });
    this.socket.send(JSON.stringify({ seq, type: 'request', command, arguments: args }));
    return promise;
  }

  /** Send a request whose adapter implementation never responds. */
  notify(command: string, args?: unknown): void {
    if (!NO_RESPONSE_COMMANDS.has(command)) {
      throw new Error(`notify() is only valid for gdb requests without a response: ${command}`);
    }
    this.send(command, args);
  }

  control(command: string, body?: unknown): void {
    if (this.closed) {
      throw new DapError('control', 'the debug session is no longer connected');
    }
    this.socket.send(JSON.stringify({ type: 'control', command, body }));
  }

  /** Ask the bridge for the in-memory protocol trace. */
  requestTrace(): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new DapError('trace', 'the debug session is no longer connected'));
        return;
      }
      this.traceWaiter = resolve;
      this.control('trace');
      setTimeout(() => {
        if (this.traceWaiter) {
          this.traceWaiter = null;
          reject(new DapError('trace', 'the bridge did not answer the trace request'));
        }
      }, 5000);
    });
  }

  close(): void {
    this.handleClose('closed by client');
    try {
      this.socket.close();
    } catch {
      // Already closed.
    }
  }

  private handleResponse(response: DapResponse): void {
    const pending = this.pending.get(response.request_seq);
    if (!pending) {
      return;
    }
    this.pending.delete(response.request_seq);
    clearTimeout(pending.timer);
    if (response.success) {
      pending.resolve(response.body ?? {});
    } else {
      const message = response.message ?? 'request failed';
      pending.reject(new DapError(pending.command, message, message));
    }
  }

  private handleClose(reason: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new DapError(pending.command, 'the debug session ended before responding'));
    }
    this.pending.clear();
    for (const listener of this.closeListeners) {
      listener(reason);
    }
  }
}

/** gdb annotates pointer results with the symbol name: "0x1234 <counter>". */
export function extractAddress(text: string): string | null {
  const match = /^(0x[0-9a-fA-F]+)/.exec(String(text).trim());
  return match ? match[1] : null;
}
