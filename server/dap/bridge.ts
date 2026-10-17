import { access, constants, stat } from 'node:fs/promises';
import path from 'node:path';

import type { WebSocket } from 'ws';

import type { StartSessionRequest } from '../../shared/types.ts';
import { GdbSession, assertExecutable, type GdbExitInfo } from './gdbSession.ts';
import type { DapMessage } from './framing.ts';
import { PtyBridge } from '../ptyBridge.ts';

interface TraceEntry {
  time: string;
  direction: 'client' | 'adapter' | 'stderr';
  message: DapMessage | string;
}

const MAX_TRACE_ENTRIES = 1500;
const MAX_CLIENT_MESSAGE_BYTES = 16 * 1024 * 1024;

/**
 * Bridges one browser WebSocket to one gdb DAP process.
 *
 * Browser -> server messages are plain DAP JSON objects. Server -> browser
 * messages are either DAP JSON objects forwarded from gdb or `control`
 * messages describing the transport itself (start-up, exit, stderr, trace).
 */
export class DapBridge {
  private session: GdbSession | null = null;
  private pty: PtyBridge | null = null;
  private readonly trace: TraceEntry[] = [];
  private closed = false;
  private startRequest: StartSessionRequest | null = null;

  private readonly ws: WebSocket;
  private readonly workspaceRoot: string;

  constructor(ws: WebSocket, workspaceRoot: string) {
    this.ws = ws;
    this.workspaceRoot = workspaceRoot;
    ws.on('message', (data, isBinary) => {
      void this.handleMessage(data, isBinary);
    });
    ws.on('close', () => {
      void this.handleClose('socket closed');
    });
    ws.on('error', () => {
      void this.handleClose('socket error');
    });
  }

  private sendJson(message: unknown): void {
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private sendControl(event: string, body?: unknown): void {
    this.sendJson({ type: 'control', event, body });
  }

  private record(direction: TraceEntry['direction'], message: DapMessage | string): void {
    this.trace.push({ time: new Date().toISOString(), direction, message: trimForTrace(message) });
    if (this.trace.length > MAX_TRACE_ENTRIES) {
      this.trace.splice(0, this.trace.length - MAX_TRACE_ENTRIES);
    }
  }

  private async handleMessage(data: unknown, isBinary: boolean): Promise<void> {
    if (isBinary) {
      this.sendControl('error', { message: 'binary WebSocket messages are not supported' });
      return;
    }
    const text = typeof data === 'string' ? data : Buffer.from(data as Buffer).toString('utf8');
    if (Buffer.byteLength(text, 'utf8') > MAX_CLIENT_MESSAGE_BYTES) {
      this.sendControl('error', { message: 'DAP message exceeds the 16 MiB limit' });
      return;
    }
    let message: DapMessage;
    try {
      message = JSON.parse(text) as DapMessage;
    } catch (error) {
      this.sendControl('error', { message: `invalid JSON from client: ${(error as Error).message}` });
      return;
    }
    if (message === null || typeof message !== 'object') {
      this.sendControl('error', { message: 'client message must be a JSON object' });
      return;
    }

    if (message.type === 'control') {
      if (message.command === 'start') {
        await this.start(message.body as StartSessionRequest);
      } else if (message.command === 'trace') {
        this.sendControl('trace', { entries: this.trace });
      } else if (message.command === 'terminalInput') {
        const body = message.body as { data?: unknown } | undefined;
        if (typeof body?.data !== 'string') {
          this.sendControl('error', { message: 'terminalInput requires a base64 "data" string' });
        } else if (this.pty) {
          this.pty.write(Buffer.from(body.data, 'base64'));
        } else {
          this.sendControl('error', {
            message: 'this session has no integrated terminal (console is internalConsole)',
          });
        }
      } else if (message.command === 'terminalResize') {
        const body = message.body as { cols?: unknown; rows?: unknown } | undefined;
        const cols = Number(body?.cols);
        const rows = Number(body?.rows);
        if (Number.isFinite(cols) && Number.isFinite(rows) && this.pty) {
          this.pty.resize(cols, rows);
        }
      } else {
        this.sendControl('error', { message: `unknown control command: ${String(message.command)}` });
      }
      return;
    }

    if (!this.session || this.session.exited) {
      this.sendControl('error', { message: 'no active gdb session; send a control "start" first' });
      return;
    }
    this.record('client', message);
    try {
      this.session.send(message);
    } catch (error) {
      this.sendControl('error', { message: (error as Error).message });
    }
  }

  private async start(request: StartSessionRequest): Promise<void> {
    if (this.session) {
      this.sendControl('error', { message: 'a gdb session is already running' });
      return;
    }
    if (!request || typeof request !== 'object') {
      this.sendControl('error', { message: 'control "start" requires a body' });
      return;
    }

    let options: { gdbPath: string; gdbArgs: string[]; program?: string; cwd: string };
    try {
      options = await this.resolveStartRequest(request);
    } catch (error) {
      this.sendControl('error', { message: (error as Error).message });
      return;
    }

    let pty: PtyBridge | null = null;
    if (request.terminal) {
      try {
        pty = await PtyBridge.create(request.terminal);
        this.pty = pty;
        pty.onData = (chunk) => {
          this.sendControl('terminalData', { data: chunk.toString('base64') });
        };
        pty.onExit = () => {
          this.sendControl('terminalExit', {});
        };
        pty.onDiagnostic = (text) => {
          this.record('stderr', text);
          this.sendControl('terminalError', { message: text });
        };
      } catch (error) {
        this.sendControl('error', { message: (error as Error).message });
        return;
      }
    }

    try {
      const session = await GdbSession.create(options);
      this.session = session;
      this.startRequest = request;
      session.onMessage = (message) => {
        this.record('adapter', message);
        this.sendJson(message);
      };
      session.onStderr = (text) => {
        this.record('stderr', text);
        this.sendControl('gdbStderr', { text });
      };
      session.onProtocolError = (error) => {
        this.sendControl('error', { message: `DAP protocol error from gdb: ${error.message}` });
        void session.dispose();
      };
      session.onExit = (info) => {
        this.onSessionExit(session, info);
      };
      this.sendControl('started', {
        pid: session.pid,
        gdbPath: options.gdbPath,
        program: options.program ?? null,
        cwd: options.cwd,
        terminal: pty ? { slave: pty.slavePath } : null,
      });
    } catch (error) {
      await this.disposePty();
      this.sendControl('error', { message: (error as Error).message });
    }
  }

  private async disposePty(): Promise<void> {
    const pty = this.pty;
    this.pty = null;
    if (pty) {
      await pty.dispose().catch(() => undefined);
    }
  }

  private async resolveStartRequest(request: StartSessionRequest) {
    const cwdInput = typeof request.cwd === 'string' && request.cwd.length > 0 ? request.cwd : '.';
    const cwd = path.resolve(this.workspaceRoot, cwdInput);
    const cwdInfo = await stat(cwd).catch(() => null);
    if (!cwdInfo?.isDirectory()) {
      throw new Error(`working directory does not exist: ${cwd}`);
    }

    let program: string | undefined;
    if (typeof request.program === 'string' && request.program.length > 0) {
      program = path.resolve(cwd, request.program);
      const info = await stat(program).catch(() => null);
      if (!info?.isFile()) {
        throw new Error(`program does not exist: ${program}`);
      }
      if (process.platform !== 'win32') {
        try {
          await access(program, constants.X_OK);
        } catch {
          throw new Error(`program is not executable: ${program}`);
        }
      }
    }

    const gdbPathInput =
      typeof request.gdbPath === 'string' && request.gdbPath.length > 0 ? request.gdbPath : 'gdb';
    const gdbPath =
      gdbPathInput.includes('/') || gdbPathInput.includes('\\')
        ? path.resolve(this.workspaceRoot, gdbPathInput)
        : gdbPathInput;
    if (gdbPath.includes('/') || gdbPath.includes('\\')) {
      await assertExecutable(gdbPath);
    }

    const gdbArgs = Array.isArray(request.gdbArgs)
      ? request.gdbArgs.map((arg) => String(arg))
      : [];
    return { gdbPath, gdbArgs, program, cwd };
  }

  private onSessionExit(session: GdbSession, info: GdbExitInfo): void {
    if (session !== this.session) {
      return;
    }
    this.sendControl('gdbExited', {
      code: info.code,
      signal: info.signal,
      program: this.startRequest?.program ?? null,
    });
    void this.disposePty();
    // Give the socket a moment to flush the control message before closing.
    setTimeout(() => {
      if (this.ws.readyState === this.ws.OPEN) {
        this.ws.close(1000, 'gdb exited');
      }
    }, 30);
  }

  private async handleClose(reason: string): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const session = this.session;
    this.session = null;
    await this.disposePty();
    if (session && !session.exited) {
      this.record('client', `disposing gdb session (${reason})`);
      await session.dispose().catch(() => {});
    }
  }

  /** Stop debugging and release the socket; used on server shutdown. */
  async shutdown(): Promise<void> {
    await this.handleClose('server shutdown');
    try {
      this.ws.close(1001, 'server shutting down');
    } catch {
      // Socket already gone.
    }
  }
}

function trimForTrace(message: DapMessage | string): DapMessage | string {
  if (typeof message === 'string') {
    return message.length > 4000 ? `${message.slice(0, 4000)}…` : message;
  }
  const json = JSON.stringify(message);
  if (json.length <= 6000) {
    return message;
  }
  return { truncated: true, preview: `${json.slice(0, 6000)}…` };
}
