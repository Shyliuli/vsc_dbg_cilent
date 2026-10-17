import { spawn, type ChildProcess } from 'node:child_process';
import { access, constants, stat } from 'node:fs/promises';

import { DapMessageReader, encodeDapMessage, type DapMessage } from './framing.ts';

export interface GdbSpawnOptions {
  /** gdb executable name or absolute path. */
  gdbPath: string;
  /** Extra gdb arguments (miDebuggerArgs), already split. */
  gdbArgs?: string[];
  /** Executable to load with the initial `file` command. */
  program?: string;
  cwd: string;
}

export interface GdbExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  reason: 'exit' | 'spawn-failed';
  error?: Error;
}

const EXIT_GRACE_MS = 750;
const SIGKILL_GRACE_MS = 2000;

/**
 * One `gdb --interpreter=dap` child process, spoken to with DAP framing.
 *
 * gdb's DAP interpreter redirects the inferior's stdout and stderr into the
 * same pipe it reports through `output` events, so gdb's own stderr is reserved
 * for interpreter startup failures.
 */
export class GdbSession {
  readonly pid: number;
  private readonly child: ChildProcess;
  private readonly reader = new DapMessageReader();
  private exitInfo: GdbExitInfo | null = null;
  private disposed = false;
  private readonly exitPromise: Promise<GdbExitInfo>;

  onMessage: (message: DapMessage) => void = () => {};
  onStderr: (text: string) => void = () => {};
  onExit: (info: GdbExitInfo) => void = () => {};
  onProtocolError: (error: Error) => void = () => {};

  static async create(options: GdbSpawnOptions): Promise<GdbSession> {
    const args = ['--interpreter=dap', '--quiet', ...(options.gdbArgs ?? [])];
    if (options.program) {
      args.push(options.program);
    }
    const child = spawn(options.gdbPath, args, {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Own process group so the inferior is cleaned up with gdb.
      detached: true,
      env: process.env,
    });

    const session = new GdbSession(child);

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        child.off('spawn', onSpawn);
        reject(error);
      };
      const onSpawn = () => {
        child.off('error', onError);
        resolve();
      };
      child.once('error', onError);
      child.once('spawn', onSpawn);
    }).catch(async (error: Error) => {
      await session.killQuietly();
      throw Object.assign(new Error(`failed to start gdb (${options.gdbPath}): ${error.message}`), {
        cause: error,
      });
    });

    return session;
  }

  private constructor(child: ChildProcess) {
    if (child.pid === undefined) {
      throw new Error('gdb was spawned without a pid');
    }
    this.child = child;
    this.pid = child.pid;

    this.exitPromise = new Promise<GdbExitInfo>((resolve) => {
      child.once('exit', (code, signal) => {
        const info: GdbExitInfo = { code, signal, reason: 'exit' };
        this.exitInfo = info;
        this.onExit(info);
        resolve(info);
      });
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      let messages: DapMessage[];
      try {
        messages = this.reader.feed(chunk);
      } catch (error) {
        this.onProtocolError(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      for (const message of messages) {
        this.onMessage(message);
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      this.onStderr(chunk.toString('utf8'));
    });

    child.stdin?.on('error', (error) => {
      // EPIPE when gdb dies before or while we write; the exit handler reports
      // the real failure.
      if ((error as NodeJS.ErrnoException).code !== 'EPIPE') {
        this.onStderr(`gdb stdin error: ${error.message}\n`);
      }
    });
  }

  get exited(): boolean {
    return this.exitInfo !== null;
  }

  send(message: unknown): void {
    if (this.exited) {
      throw new Error('cannot send a DAP message: gdb has exited');
    }
    this.child.stdin?.write(encodeDapMessage(message));
  }

  /** Wait for gdb to exit; resolves with exit information. */
  waitForExit(): Promise<GdbExitInfo> {
    return this.exitPromise;
  }

  /**
   * Close stdin (gdb's DAP reader then exits cleanly), then escalate to
   * SIGTERM and SIGKILL on the gdb process group.
   */
  async dispose(): Promise<void> {
    if (this.disposed) {
      await this.exitPromise;
      return;
    }
    this.disposed = true;
    this.child.stdin?.end();
    const graceful = await Promise.race([
      this.exitPromise.then(() => true),
      delay(EXIT_GRACE_MS).then(() => false),
    ]);
    if (!graceful) {
      this.signalGroup('SIGTERM');
      const terminated = await Promise.race([
        this.exitPromise.then(() => true),
        delay(SIGKILL_GRACE_MS).then(() => false),
      ]);
      if (!terminated) {
        this.signalGroup('SIGKILL');
        await Promise.race([this.exitPromise, delay(SIGKILL_GRACE_MS)]);
      }
    }
    await this.exitPromise;
  }

  /** Best-effort kill used when spawn never completed. */
  async killQuietly(): Promise<void> {
    this.signalGroup('SIGKILL');
    await Promise.race([this.exitPromise.catch(() => null), delay(SIGKILL_GRACE_MS)]);
  }

  private signalGroup(signal: NodeJS.Signals): void {
    if (this.exited) {
      return;
    }
    try {
      // Negative pid addresses the detached process group, taking the inferior
      // down with gdb.
      process.kill(-this.pid, signal);
    } catch {
      try {
        this.child.kill(signal);
      } catch {
        // Already gone.
      }
    }
  }
}

export async function assertExecutable(file: string): Promise<void> {
  const info = await stat(file).catch(() => null);
  if (!info) {
    throw new Error(`gdb executable not found: ${file}`);
  }
  if (!info.isFile()) {
    throw new Error(`gdb executable is not a regular file: ${file}`);
  }
  try {
    await access(file, constants.X_OK);
  } catch {
    throw new Error(`gdb executable is not executable: ${file}`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
