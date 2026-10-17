import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HELPER_PATH = fileURLToPath(new URL('./pty_helper.py', import.meta.url));
const READY_TIMEOUT_MS = 5000;
const DISPOSE_GRACE_MS = 750;
const MAX_DIAGNOSTIC_LENGTH = 2000;

export interface PtyOptions {
  cols?: number;
  rows?: number;
}

/**
 * A pty allocated for one debug session so the inferior can have a real
 * terminal (stdin/stdout/stderr) instead of /dev/null.
 *
 * gdb is pointed at the slave path with `set inferior-tty`; this class keeps
 * the master side connected to the browser terminal.
 */
export class PtyBridge {
  readonly slavePath: string;
  private readonly child: ChildProcess;
  private readonly diagnostics: string[] = [];
  private exited = false;
  private disposed = false;

  onData: (chunk: Buffer) => void = () => {};
  onExit: () => void = () => {};
  onDiagnostic: (text: string) => void = () => {};

  static async create(options: PtyOptions = {}): Promise<PtyBridge> {
    const cols = clampDimension(options.cols, 100);
    const rows = clampDimension(options.rows, 30);
    const child = spawn('python3', ['-u', HELPER_PATH], {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PTY_COLS: String(cols),
        PTY_ROWS: String(rows),
      },
    });

    let pendingData = '';
    const slavePath = await new Promise<string>((resolve, reject) => {
      let buffer = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          child.kill('SIGKILL');
          reject(new Error(`the pty helper did not become ready within ${READY_TIMEOUT_MS} ms`));
        }
      }, READY_TIMEOUT_MS);

      const onError = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(
          new Error(
            `integratedTerminal requires python3 and a pty-capable system: ${error.message}`,
          ),
        );
      };

      child.once('error', onError);
      child.once('exit', (code) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        const details = child.stderr ? 'see stderr' : '';
        reject(new Error(`the pty helper exited before it was ready (code ${code}) ${details}`));
      });

      child.stdout?.on('data', (chunk: Buffer) => {
        if (settled) {
          return;
        }
        buffer += chunk.toString('utf8');
        const newline = buffer.indexOf('\n');
        if (newline === -1) {
          if (buffer.length > 4096) {
            settled = true;
            clearTimeout(timer);
            child.kill('SIGKILL');
            reject(new Error('the pty helper sent an invalid ready line'));
          }
          return;
        }
        settled = true;
        clearTimeout(timer);
        child.off('error', onError);
        const path = buffer.slice(0, newline).trim();
        if (!path.startsWith('/dev/pts/') && !path.startsWith('/dev/tty')) {
          child.kill('SIGKILL');
          reject(new Error(`the pty helper reported an unexpected slave path: ${path}`));
          return;
        }
        // Data before the session exists cannot happen in practice, but do not
        // drop it silently if it does.
        pendingData = buffer.slice(newline + 1);
        resolve(path);
      });
    });

    const bridge = new PtyBridge(child, slavePath);
    if (pendingData.length > 0) {
      const initial = Buffer.from(pendingData, 'utf8');
      setImmediate(() => bridge.onData(initial));
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (!bridge.exited) {
        bridge.onData(chunk);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (text.trim().length > 0) {
        bridge.diagnostics.push(text);
        if (bridge.diagnostics.join('').length > MAX_DIAGNOSTIC_LENGTH) {
          bridge.diagnostics.shift();
        }
        bridge.onDiagnostic(text);
      }
    });
    child.on('exit', () => {
      bridge.exited = true;
      bridge.onExit();
    });

    return bridge;
  }

  private constructor(child: ChildProcess, slavePath: string) {
    this.child = child;
    this.slavePath = slavePath;
  }

  write(data: Buffer): void {
    if (this.exited || this.disposed) {
      return;
    }
    this.child.stdin?.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.exited || this.disposed) {
      return;
    }
    const control = this.child.stdio[3];
    if (control && 'write' in control && control.writable) {
      control.write(`RESIZE ${clampDimension(cols, 100)} ${clampDimension(rows, 30)}\n`);
    }
  }

  diagnosticText(): string {
    return this.diagnostics.join('').trim().slice(-MAX_DIAGNOSTIC_LENGTH);
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.exited) {
      return;
    }
    try {
      this.child.stdin?.end();
    } catch {
      // Already gone.
    }
    this.child.kill('SIGTERM');
    const exited = await Promise.race([
      new Promise<boolean>((resolve) => this.child.once('exit', () => resolve(true))),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), DISPOSE_GRACE_MS)),
    ]);
    if (!exited) {
      this.child.kill('SIGKILL');
    }
  }
}

function clampDimension(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(500, Math.max(10, Math.floor(value)));
}
