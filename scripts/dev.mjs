import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Development runner: the API/DAP backend and the Vite dev server.
 * In production everything is served from the backend (`npm run build && npm start`).
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const children = [];

function start(name, command, args) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  const prefix = `[${name}] `;
  const forward = (stream, target) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        target.write(prefix + line + '\n');
      }
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);
  child.on('exit', (code) => {
    console.log(`${prefix}exited with code ${code}`);
    shutdown(code ?? 0);
  });
  children.push(child);
  return child;
}

let stopping = false;
function shutdown(code) {
  if (stopping) {
    return;
  }
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
    }
  }
  setTimeout(() => process.exit(code), 200);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

start('server', process.execPath, ['--watch', 'server/main.ts']);
start('web', process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')]);
