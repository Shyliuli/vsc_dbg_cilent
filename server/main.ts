import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { WebSocketServer } from 'ws';

import { DapBridge } from './dap/bridge.ts';
import type { FileContent, LaunchFileResult } from '../shared/types.ts';
import { readLaunchFile, writeLaunchFile } from './launchConfig.ts';
import { listProcesses } from './processes.ts';
import { Workspace } from './workspace.ts';

const execFileAsync = promisify(execFile);
const MAX_JSON_BODY_BYTES = 8 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

export interface ServerOptions {
  workspaceRoot?: string;
  port?: number;
  host?: string;
  distDir?: string;
}

export interface RunningServer {
  server: Server;
  port: number;
  url: string;
  workspace: Workspace;
  close: () => Promise<void>;
}

interface GdbEnvironment {
  gdbPath: string;
  version: string | null;
  available: boolean;
  error?: string;
}

let gdbEnvironmentPromise: Promise<GdbEnvironment> | null = null;

function probeGdb(): Promise<GdbEnvironment> {
  if (!gdbEnvironmentPromise) {
    gdbEnvironmentPromise = execFileAsync('gdb', ['--version'], { timeout: 5000 })
      .then(({ stdout }) => {
        const firstLine = stdout.split('\n')[0]?.trim() ?? '';
        return { gdbPath: 'gdb', version: firstLine, available: true };
      })
      .catch((error: Error) => ({
        gdbPath: 'gdb',
        version: null,
        available: false,
        error: error.message,
      }));
  }
  return gdbEnvironmentPromise;
}

export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
  const distDir = path.resolve(options.distDir ?? path.join(workspaceRoot, 'dist'));
  const workspace = new Workspace(workspaceRoot);
  const bridges = new Set<DapBridge>();

  const httpServer = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!response.headersSent) {
        sendJson(response, 500, { error: message });
      } else {
        response.end();
      }
    });
  });

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);

    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');

    // This process can read files and spawn gdb. Only the local machine may
    // drive it; browsers always attach an Origin header for cross-origin
    // requests, so reject anything that is not loopback.
    if (!isLoopbackOrigin(request.headers.origin)) {
      sendJson(response, 403, { error: 'cross-origin requests are not allowed' });
      return;
    }

    if (pathname.startsWith('/api/')) {
      response.setHeader('Cache-Control', 'no-store');
      await handleApi(request, response, url, pathname);
      return;
    }

    await serveStatic(pathname, response);
  }

  async function handleApi(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    pathname: string,
  ): Promise<void> {
    const method = request.method ?? 'GET';

    try {
      if (pathname === '/api/health' && method === 'GET') {
        sendJson(response, 200, { ok: true });
        return;
      }

      if (pathname === '/api/workspace' && method === 'GET') {
        sendJson(response, 200, {
          root: workspaceRoot,
          name: path.basename(workspaceRoot),
        });
        return;
      }

      if (pathname === '/api/environment' && method === 'GET') {
        const environment = await probeGdb();
        sendJson(response, 200, {
          ...environment,
          platform: process.platform,
          arch: process.arch,
          node: process.version,
        });
        return;
      }

      if (pathname === '/api/tree' && method === 'GET') {
        const entries = await workspace.list(url.searchParams.get('path') ?? '');
        sendJson(response, 200, { entries });
        return;
      }

      if (pathname === '/api/files' && method === 'GET') {
        sendJson(response, 200, { files: await workspace.listFiles() });
        return;
      }

      if (pathname === '/api/file' && method === 'GET') {
        const requested = url.searchParams.get('path');
        if (!requested) {
          throw new Error('query parameter "path" is required');
        }
        sendJson(response, 200, await workspace.readText(requested));
        return;
      }

      if (pathname === '/api/file' && method === 'PUT') {
        const body = await readJsonBody<{ path?: string; content?: string }>(request);
        if (typeof body.path !== 'string' || body.path.length === 0) {
          throw new Error('body field "path" is required');
        }
        if (typeof body.content !== 'string') {
          throw new Error('body field "content" is required');
        }
        const saved: FileContent = await workspace.writeText(body.path, body.content);
        sendJson(response, 200, saved);
        return;
      }

      if (pathname === '/api/launch' && method === 'GET') {
        const focusedFile = url.searchParams.get('file') ?? undefined;
        sendJson(response, 200, await readLaunchFile(workspaceRoot, focusedFile));
        return;
      }

      if (pathname === '/api/launch' && method === 'PUT') {
        const body = await readJsonBody<{ content?: string; file?: string }>(request);
        if (typeof body.content !== 'string') {
          throw new Error('body field "content" is required');
        }
        const result: LaunchFileResult = await writeLaunchFile(
          workspaceRoot,
          body.content,
          body.file,
        );
        sendJson(response, 200, { saved: true, ...result });
        return;
      }

      if (pathname === '/api/processes' && method === 'GET') {
        sendJson(response, 200, { processes: await listProcesses() });
        return;
      }

      sendJson(response, 404, { error: `unknown API endpoint: ${method} ${pathname}` });
    } catch (error) {
      // Every API failure here is either bad input or a missing file. Report
      // the message to the client and keep the server log for diagnosis.
      console.error(`[api] ${method} ${pathname} failed:`, error);
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 400, { error: message });
    }
  }

  async function serveStatic(pathname: string, response: ServerResponse): Promise<void> {
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const candidate = path.resolve(distDir, relative);
    if (!candidate.startsWith(distDir + path.sep) && candidate !== path.join(distDir, 'index.html')) {
      sendJson(response, 403, { error: 'forbidden' });
      return;
    }
    const info = await stat(candidate).catch(() => null);
    if (info?.isFile()) {
      response.setHeader('Content-Type', CONTENT_TYPES[path.extname(candidate)] ?? 'application/octet-stream');
      response.setHeader('Cache-Control', candidate.endsWith('.html') ? 'no-store' : 'public, max-age=3600');
      createReadStream(candidate).pipe(response);
      return;
    }
    if (path.extname(candidate) === '') {
      const indexFile = path.join(distDir, 'index.html');
      if (await stat(indexFile).catch(() => null)) {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        createReadStream(indexFile).pipe(response);
        return;
      }
    }
    sendJson(response, 404, {
      error: `not found: ${pathname}`,
      hint: 'run "npm run build" to produce dist/, or use the Vite dev server on port 5173',
    });
  }

  const wsServer = new WebSocketServer({
    server: httpServer,
    path: '/ws/dap',
    verifyClient: (info: { origin?: string }) => isLoopbackOrigin(info.origin),
  });
  wsServer.on('connection', (socket) => {
    const bridge = new DapBridge(socket, workspaceRoot);
    bridges.add(bridge);
    socket.on('close', () => bridges.delete(bridge));
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(options.port ?? 3000, options.host ?? '127.0.0.1', () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : (options.port ?? 3000);
  const host = options.host ?? '127.0.0.1';

  return {
    server: httpServer,
    port,
    url: `http://${host}:${port}`,
    workspace,
    close: async () => {
      for (const bridge of [...bridges]) {
        await bridge.shutdown();
      }
      bridges.clear();
      await new Promise<void>((resolve) => wsServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

function isLoopbackOrigin(origin: string | undefined): boolean {
  if (!origin) {
    // Non-browser clients (tests, curl) do not send Origin.
    return true;
  }
  try {
    const url = new URL(origin);
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1' || url.hostname === '[::1]';
  } catch {
    return false;
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(payload);
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_JSON_BODY_BYTES) {
      throw new Error(`request body exceeds ${MAX_JSON_BODY_BYTES} bytes`);
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    throw new Error('request body is required');
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch (error) {
    throw new Error(`request body is not valid JSON: ${(error as Error).message}`);
  }
}

async function main(): Promise<void> {
  const running = await startServer({
    workspaceRoot: process.env.GDB_CLIENT_WORKSPACE
      ? path.resolve(process.env.GDB_CLIENT_WORKSPACE)
      : process.cwd(),
    port: process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 3000,
    host: process.env.HOST ?? '127.0.0.1',
  });
  const environment = await probeGdb();
  console.log(`gdb-client server listening on ${running.url}`);
  console.log(`  workspace: ${running.workspace.root}`);
  console.log(
    `  gdb: ${environment.available ? environment.version : `unavailable (${environment.error})`}`,
  );

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) {
      return;
    }
    closing = true;
    console.log(`\nreceived ${signal}, shutting down`);
    const timeout = setTimeout(() => process.exit(1), 5000);
    await running.close();
    clearTimeout(timeout);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  main().catch((error: unknown) => {
    console.error('failed to start gdb-client server:', error);
    process.exit(1);
  });
}
