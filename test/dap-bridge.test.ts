import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { WebSocket } from 'ws';

import { startServer, type RunningServer } from '../server/main.ts';
import { parseWatchpointList, parseWatchpointNumber } from '../shared/watchpoints.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEMO_DIR = path.join(ROOT, 'examples', 'cpp-demo');
const DEMO_BINARY = path.join(DEMO_DIR, 'build', 'cpp-demo');
const DEMO_SOURCE = path.join(DEMO_DIR, 'src', 'main.cpp');
const STDIO_DIR = path.join(ROOT, 'examples', 'stdio-echo');
const STDIO_BINARY = path.join(STDIO_DIR, 'build', 'stdio-echo');

/** Derive breakpoint lines from the source so edits do not break the test. */
const DEMO_LINES = readFileSync(DEMO_SOURCE, 'utf8').split('\n');
function lineContaining(needle: string): number {
  const index = DEMO_LINES.findIndex((line) => line.includes(needle));
  if (index < 0) {
    throw new Error(`demo source does not contain: ${needle}`);
  }
  return index + 1;
}
const LOOP_LINE = lineContaining('total = add(total, values[i]);');
const LOG_LINE = lineContaining('std::printf("i=%zu total=%d');

const EVENT_TIMEOUT_MS = 15000;

interface DapMessage {
  type: string;
  event?: string;
  command?: string;
  request_seq?: number;
  success?: boolean;
  message?: string;
  body?: any;
  seq?: number;
}

interface Waiter {
  event: string;
  resolve: (message: DapMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  predicate: (message: DapMessage) => boolean;
}

class DapClient {
  private readonly ws: WebSocket;
  private seq = 0;
  private readonly pending = new Map<
    number,
    { command: string; resolve: (body: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private readonly eventQueues = new Map<string, DapMessage[]>();
  private readonly waiters: Waiter[] = [];
  private readonly controlQueues = new Map<string, DapMessage[]>();
  private readonly controlWaiters: Waiter[] = [];
  readonly log: DapMessage[] = [];
  terminalOutput = '';
  private closed = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (data) => this.onMessage(Buffer.from(data as Buffer).toString('utf8')));
    ws.on('close', () => {
      this.closed = true;
      for (const waiter of [...this.waiters, ...this.controlWaiters]) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`socket closed while waiting for ${waiter.event}`));
      }
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`socket closed while waiting for response to ${pending.command}`));
      }
      this.pending.clear();
    });
  }

  static async connect(url: string): Promise<DapClient> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (error) => reject(error));
    });
    return new DapClient(ws);
  }

  private onMessage(text: string): void {
    const message = JSON.parse(text) as DapMessage;
    this.log.push(message);
    if (process.env.DAP_TEST_DEBUG) {
      console.error(
        `<< ${message.type} ${message.event ?? message.command ?? ''} ${JSON.stringify(message.body ?? '').slice(0, 220)}`,
      );
    }
    if (message.type === 'response') {
      const pending = this.pending.get(message.request_seq ?? -1);
      if (!pending) {
        return;
      }
      this.pending.delete(message.request_seq ?? -1);
      clearTimeout(pending.timer);
      if (message.success) {
        pending.resolve(message.body ?? {});
      } else {
        pending.reject(new Error(`${pending.command} failed: ${message.message ?? 'unknown error'}`));
      }
      return;
    }
    if (message.type === 'control' && message.event === 'terminalData') {
      this.terminalOutput += Buffer.from(String(message.body?.data ?? ''), 'base64').toString('utf8');
    }
    if (message.type === 'event' || message.type === 'control') {
      this.dispatch(message);
    }
  }

  private dispatch(message: DapMessage): void {
    const isControl = message.type === 'control';
    const name = isControl ? String(message.event) : String(message.event);
    const waiters = isControl ? this.controlWaiters : this.waiters;
    const queues = isControl ? this.controlQueues : this.eventQueues;

    const index = waiters.findIndex((waiter) => waiter.event === name && waiter.predicate(message));
    if (index >= 0) {
      const waiter = waiters[index];
      waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }
    const queue = queues.get(name) ?? [];
    queue.push(message);
    queues.set(name, queue);
  }

  private waitFor(
    kind: 'event' | 'control',
    name: string,
    predicate: (message: DapMessage) => boolean = () => true,
    timeoutMs = EVENT_TIMEOUT_MS,
  ): Promise<DapMessage> {
    const queues = kind === 'event' ? this.eventQueues : this.controlQueues;
    const waiters = kind === 'event' ? this.waiters : this.controlWaiters;
    const queue = queues.get(name) ?? [];
    const index = queue.findIndex(predicate);
    if (index >= 0) {
      const [message] = queue.splice(index, 1);
      return Promise.resolve(message);
    }
    return new Promise<DapMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = waiters.findIndex((waiter) => waiter.timer === timer);
        if (idx >= 0) {
          waiters.splice(idx, 1);
        }
        const tail = this.log
          .slice(-8)
          .map((entry) => `${entry.type}:${entry.event ?? entry.command ?? ''}`)
          .join(', ');
        reject(new Error(`timed out waiting for ${kind} "${name}"; recent messages: ${tail}`));
      }, timeoutMs);
      waiters.push({ event: name, resolve, reject, timer, predicate });
    });
  }

  waitEvent(
    name: string,
    predicate?: (message: DapMessage) => boolean,
    timeoutMs?: number,
  ): Promise<DapMessage> {
    return this.waitFor('event', name, predicate, timeoutMs);
  }

  waitControl(name: string, timeoutMs?: number): Promise<DapMessage> {
    return this.waitFor('control', name, () => true, timeoutMs);
  }

  /** Poll the accumulated pty output for a substring. */
  async waitForTerminalText(text: string, timeoutMs = EVENT_TIMEOUT_MS): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (!this.terminalOutput.includes(text)) {
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for terminal text ${JSON.stringify(text)}; output was ${JSON.stringify(
            this.terminalOutput.slice(-500),
          )}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return this.terminalOutput;
  }

  terminalInput(text: string): void {
    this.control('terminalInput', { data: Buffer.from(text, 'utf8').toString('base64') });
  }

  control(command: string, body?: unknown): void {
    this.ws.send(JSON.stringify({ type: 'control', command, body }));
  }

  /** Send a request that does return a DAP response. */
  async request(command: string, args?: unknown, timeoutMs = EVENT_TIMEOUT_MS): Promise<any> {
    const seq = ++this.seq;
    const promise = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`timed out waiting for response to ${command}`));
      }, timeoutMs);
      this.pending.set(seq, { command, resolve, reject, timer });
    });
    this.ws.send(JSON.stringify({ seq, type: 'request', command, arguments: args }));
    return promise;
  }

  /** Send a request that gdb implements without sending a response. */
  notify(command: string, args?: unknown): void {
    const seq = ++this.seq;
    this.ws.send(JSON.stringify({ seq, type: 'request', command, arguments: args }));
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }
}

async function withServer<T>(fn: (server: RunningServer) => Promise<T>): Promise<T> {
  const server = await startServer({ workspaceRoot: ROOT, port: 0 });
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

function demoClientCapabilities() {
  return {
    clientID: 'gdb-client-test',
    clientName: 'gdb-client test',
    adapterID: 'gdb',
    pathFormat: 'path',
    linesStartAt1: true,
    columnsStartAt1: true,
    supportsVariableType: true,
    supportsVariablePaging: true,
    supportsMemoryReferences: true,
    supportsRunInTerminalRequest: false,
    supportsProgressReporting: false,
  };
}

test('builds the demo programs used by the debugger tests', () => {
  execFileSync('make', ['-C', DEMO_DIR], { stdio: 'pipe' });
  execFileSync('make', ['-C', STDIO_DIR], { stdio: 'pipe' });
});

test('reports a clear error when the start request points at a missing program', async () => {
  await withServer(async (server) => {
    const client = await DapClient.connect(`ws://127.0.0.1:${server.port}/ws/dap`);
    try {
      client.control('start', {
        gdbPath: 'gdb',
        program: path.join(DEMO_DIR, 'build', 'does-not-exist'),
        cwd: DEMO_DIR,
      });
      const error = await client.waitControl('error');
      assert.match(String(error.body?.message), /program does not exist/);
    } finally {
      await client.close();
    }
  });
});

test('drives launch, breakpoints, stepping, evaluation, disassembly and exit', async () => {
  await withServer(async (server) => {
    const client = await DapClient.connect(`ws://127.0.0.1:${server.port}/ws/dap`);
    try {
      client.control('start', { gdbPath: 'gdb', program: DEMO_BINARY, cwd: DEMO_DIR });
      const started = await client.waitControl('started');
      assert.ok(Number(started.body?.pid) > 0);
      assert.equal(started.body?.terminal ?? null, null);

      const capabilities = await client.request('initialize', demoClientCapabilities());
      await client.waitEvent('initialized');
      assert.equal(capabilities.supportsConditionalBreakpoints, true);
      assert.equal(capabilities.supportsHitConditionalBreakpoints, true);
      assert.equal(capabilities.supportsLogPoints, true);
      assert.equal(capabilities.supportsFunctionBreakpoints, true);
      assert.equal(capabilities.supportsInstructionBreakpoints, true);
      assert.equal(capabilities.supportsReadMemoryRequest, true);
      assert.equal(capabilities.supportsDisassembleRequest, true);
      assert.equal(capabilities.supportsSetVariable, true);
      assert.equal(capabilities.supportsEvaluateForHovers, true);

      // Same default cpptools applies before launching.
      await client.request('evaluate', { expression: 'set confirm off', context: 'repl' });
      await client.request('evaluate', { expression: 'set pagination off', context: 'repl' });

      const launchPromise = client.request('launch', {
        program: DEMO_BINARY,
        cwd: DEMO_DIR,
        args: ['e2e-argument'],
      });

      const setResult = await client.request('setBreakpoints', {
        source: { path: DEMO_SOURCE },
        breakpoints: [
          { line: LOG_LINE, logMessage: 'log i={i} total={total}' },
          { line: LOOP_LINE, condition: 'i == 2' },
        ],
      });
      assert.equal(setResult.breakpoints.length, 2);
      assert.equal(setResult.breakpoints[0].verified, true);
      assert.equal(setResult.breakpoints[1].verified, true);
      const logBpId = setResult.breakpoints[0].id;
      const conditionalBpId = setResult.breakpoints[1].id;
      assert.ok(logBpId > 0 && conditionalBpId > 0);

      const exceptionResult = await client.request('setExceptionBreakpoints', {
        filters: ['throw'],
      });
      assert.equal(exceptionResult.breakpoints.length, 1);
      const exceptionBpId = exceptionResult.breakpoints[0].id;

      const configurationDone = client.request('configurationDone', {});
      await configurationDone;
      await launchPromise;

      const stoppedAtLoop = await client.waitEvent(
        'stopped',
        (message) => (message.body?.hitBreakpointIds ?? []).includes(conditionalBpId),
      );
      assert.equal(stoppedAtLoop.body.reason, 'breakpoint');
      const threadId = stoppedAtLoop.body.threadId as number;
      assert.ok(threadId > 0);

      const threads = await client.request('threads', {});
      assert.ok(threads.threads.some((thread: { id: number }) => thread.id === threadId));

      const stack = await client.request('stackTrace', { threadId });
      assert.ok(stack.stackFrames.length >= 1);
      const topFrame = stack.stackFrames[0];
      assert.equal(topFrame.line, LOOP_LINE);
      assert.match(topFrame.name, /main/);
      assert.equal(topFrame.source.path, DEMO_SOURCE);
      assert.match(String(topFrame.instructionPointerReference), /^0x[0-9a-f]+$/);

      const scopes = await client.request('scopes', { frameId: topFrame.id });
      const scopeNames = scopes.scopes.map((scope: { name: string }) => scope.name);
      assert.ok(scopeNames.includes('Locals'), `expected Locals in ${scopeNames.join(',')}`);
      assert.ok(scopeNames.includes('Registers'), `expected Registers in ${scopeNames.join(',')}`);
      const localsRef = scopes.scopes.find((scope: { name: string }) => scope.name === 'Locals')
        .variablesReference;
      const registersRef = scopes.scopes.find((scope: { name: string }) => scope.name === 'Registers')
        .variablesReference;

      const allLocals = await client.request('variables', { variablesReference: localsRef });
      const localsByName = new Map<string, any>(
        allLocals.variables.map((variable: any) => [variable.name, variable]),
      );
      for (const expected of ['i', 'total', 'values', 'point', 'point_ptr', 'label']) {
        assert.ok(localsByName.has(expected), `expected local ${expected}`);
      }
      assert.equal(typeof localsByName.get('i').type, 'string');
      assert.equal(localsByName.get('i').value, '2');

      // Paging is honored because the test client advertises support.
      const paged = await client.request('variables', {
        variablesReference: localsRef,
        start: 0,
        count: 1,
      });
      assert.equal(paged.variables.length, 1);

      // Registers are a scope, matching what cpptools surfaces.
      const registers = await client.request('variables', {
        variablesReference: registersRef,
        start: 0,
        count: 5,
      });
      assert.ok(registers.variables.length > 0);
      assert.ok(
        registers.variables.every(
          (variable: any) => typeof variable.name === 'string' && variable.name.length > 0,
        ),
      );

      const evaluated = await client.request('evaluate', {
        expression: 'i',
        frameId: topFrame.id,
        context: 'variables',
      });
      assert.equal(evaluated.result, '2');

      const hovered = await client.request('evaluate', {
        expression: 'point_ptr->x',
        frameId: topFrame.id,
        context: 'hover',
      });
      assert.equal(hovered.result, '3');

      const assigned = await client.request('setVariable', {
        variablesReference: localsRef,
        name: 'total',
        value: '99',
      });
      assert.equal(assigned.value, '99');
      const reassigned = await client.request('evaluate', {
        expression: 'total',
        frameId: topFrame.id,
        context: 'variables',
      });
      assert.equal(reassigned.result, '99');

      // gdb's DAP disassemble starts at memoryReference and slices forward;
      // negative instructionOffset only trims within that window.
      const disassembled = await client.request('disassemble', {
        memoryReference: topFrame.instructionPointerReference,
        instructionOffset: 0,
        instructionCount: 5,
      });
      assert.equal(disassembled.instructions.length, 5);
      for (const instruction of disassembled.instructions) {
        assert.match(instruction.address, /^0x[0-9a-f]+$/);
        assert.equal(typeof instruction.instruction, 'string');
        assert.match(instruction.instructionBytes, /^[0-9a-f]*$/);
      }

      const counterAddress = await client.request('evaluate', {
        expression: '&counter',
        frameId: topFrame.id,
        context: 'variables',
      });
      // gdb annotates pointer results with the symbol name, e.g.
      // "0x5555555700e8 <counter>"; the address is the hex prefix.
      const addressMatch = /^(0x[0-9a-fA-F]+)/.exec(String(counterAddress.result));
      assert.ok(addressMatch, `expected an address, got ${counterAddress.result}`);
      const memory = await client.request('readMemory', {
        memoryReference: addressMatch[1],
        count: 4,
      });
      assert.equal(Buffer.from(memory.data, 'base64').length, 4);

      // Stepping into line 68 first descends into the vector operator[] call,
      // so assert that the step request itself lands in a deeper frame.
      client.notify('stepIn', { threadId });
      await client.waitEvent('stopped', (message) => message.body?.reason === 'step');
      const innerStack = await client.request('stackTrace', { threadId });
      assert.notEqual(innerStack.stackFrames[0].name, 'main');

      const stepOutResponse = client.request('stepOut', { threadId });
      await stepOutResponse;
      await client.waitEvent('stopped', (message) => message.body?.reason === 'step');
      const afterStepOut = await client.request('stackTrace', { threadId });
      assert.match(afterStepOut.stackFrames[0].name, /main/);

      client.notify('next', { threadId });
      await client.waitEvent('stopped', (message) => message.body?.reason === 'step');

      // Function breakpoints with a condition.
      const functionBps = await client.request('setFunctionBreakpoints', {
        breakpoints: [{ name: 'factorial', condition: 'n == 6' }],
      });
      assert.equal(functionBps.breakpoints[0].verified, true);
      const factorialBpId = functionBps.breakpoints[0].id;

      client.notify('continue', { threadId });
      const factorialStop = await client.waitEvent(
        'stopped',
        (message) => (message.body?.hitBreakpointIds ?? []).includes(factorialBpId),
      );
      const factorialStack = await client.request('stackTrace', {
        threadId: factorialStop.body.threadId,
      });
      assert.equal(factorialStack.stackFrames[0].name, 'factorial');

      // The logpoint must have produced console output during the loop.
      const logOutput = await client.waitEvent(
        'output',
        (message) =>
          message.body?.category === 'console' && /log i=\d+ total=\d+/.test(message.body.output ?? ''),
      );
      assert.match(logOutput.body.output, /log i=\d+ total=\d+/);

      // Remove function breakpoints, then run into the C++ exception catchpoint.
      await client.request('setFunctionBreakpoints', { breakpoints: [] });
      client.notify('continue', { threadId: factorialStop.body.threadId });
      const exceptionStop = await client.waitEvent(
        'stopped',
        (message) => (message.body?.hitBreakpointIds ?? []).includes(exceptionBpId),
      );
      const exceptionStack = await client.request('stackTrace', {
        threadId: exceptionStop.body.threadId,
      });
      assert.ok(
        exceptionStack.stackFrames.some((frame: { name: string }) => /risky|cxa_throw/.test(frame.name)),
        `expected exception frames, got ${exceptionStack.stackFrames.map((f: any) => f.name).join(',')}`,
      );

      client.notify('continue', { threadId: exceptionStop.body.threadId });
      const exited = await client.waitEvent('exited');
      assert.equal(exited.body?.exitCode, 0);
      await client.waitEvent('terminated');

      const disconnect = client.request('disconnect', {});
      await disconnect;
      const gdbExited = await client.waitControl('gdbExited');
      assert.equal(gdbExited.body?.code, 0);
    } finally {
      await client.close();
    }
  });
});

test('honors DAP hitCondition breakpoints', async () => {
  await withServer(async (server) => {
    const client = await DapClient.connect(`ws://127.0.0.1:${server.port}/ws/dap`);
    try {
      client.control('start', { gdbPath: 'gdb', program: DEMO_BINARY, cwd: DEMO_DIR });
      await client.waitControl('started');
      await client.request('initialize', demoClientCapabilities());
      await client.waitEvent('initialized');
      await client.request('evaluate', { expression: 'set confirm off', context: 'repl' });

      const launchPromise = client.request('launch', { program: DEMO_BINARY, cwd: DEMO_DIR });
      // gdb maps hitCondition onto its ignore count: the first two hits are
      // skipped and the third crossing stops, which is i == 2 here.
      const setResult = await client.request('setBreakpoints', {
        source: { path: DEMO_SOURCE },
        breakpoints: [{ line: LOOP_LINE, hitCondition: '2' }],
      });
      const bpId = setResult.breakpoints[0].id;
      await client.request('configurationDone', {});
      await launchPromise;

      const stopped = await client.waitEvent(
        'stopped',
        (message) => (message.body?.hitBreakpointIds ?? []).includes(bpId),
      );
      const stack = await client.request('stackTrace', { threadId: stopped.body.threadId });
      assert.equal(stack.stackFrames[0].line, LOOP_LINE);
      const scopes = await client.request('scopes', { frameId: stack.stackFrames[0].id });
      const locals = scopes.scopes.find((scope: { name: string }) => scope.name === 'Locals');
      const values = await client.request('variables', {
        variablesReference: locals.variablesReference,
      });
      const i = values.variables.find((variable: any) => variable.name === 'i');
      assert.equal(i.value, '2');

      await client.request('disconnect', { terminateDebuggee: true });
      await client.waitControl('gdbExited');
    } finally {
      await client.close();
    }
  });
});

test('drives program stdin and stdout through the integrated terminal pty', async () => {
  await withServer(async (server) => {
    const client = await DapClient.connect(`ws://127.0.0.1:${server.port}/ws/dap`);
    try {
      client.control('start', {
        gdbPath: 'gdb',
        program: STDIO_BINARY,
        cwd: STDIO_DIR,
        terminal: { cols: 100, rows: 30 },
      });
      const started = await client.waitControl('started');
      const slave = String(started.body?.terminal?.slave ?? '');
      assert.match(slave, /^\/dev\/pts\//, `expected a pty slave path, got ${slave}`);

      await client.request('initialize', demoClientCapabilities());
      await client.waitEvent('initialized');
      await client.request('evaluate', { expression: 'set confirm off', context: 'repl' });
      await client.request('evaluate', {
        expression: `set inferior-tty ${slave}`,
        context: 'repl',
      });

      const launchPromise = client.request('launch', { program: STDIO_BINARY, cwd: STDIO_DIR });
      await client.request('configurationDone', {});
      await launchPromise;

      await client.waitForTerminalText('name? ');
      client.terminalInput('world\n');
      await client.waitForTerminalText('value? ');
      client.terminalInput('5\n');
      const output = await client.waitForTerminalText('hello world, doubled=10');
      // Echo is provided by the pty, exactly like a real terminal.
      assert.match(output, /name\? world/);

      const exited = await client.waitEvent('exited');
      assert.equal(exited.body?.exitCode, 0);
      await client.request('disconnect', {});
      await client.waitControl('gdbExited');
    } finally {
      await client.close();
    }
  });
});

test('maps data breakpoints onto gdb watchpoints', async () => {
  await withServer(async (server) => {
    const client = await DapClient.connect(`ws://127.0.0.1:${server.port}/ws/dap`);
    try {
      client.control('start', { gdbPath: 'gdb', program: DEMO_BINARY, cwd: DEMO_DIR });
      await client.waitControl('started');
      await client.request('initialize', demoClientCapabilities());
      await client.waitEvent('initialized');
      await client.request('evaluate', { expression: 'set confirm off', context: 'repl' });

      const launchPromise = client.request('launch', {
        program: DEMO_BINARY,
        cwd: DEMO_DIR,
        stopAtBeginningOfMainSubprogram: true,
      });
      await client.request('configurationDone', {});
      await launchPromise;
      const atMain = await client.waitEvent('stopped');
      assert.ok(atMain.body?.threadId > 0);

      // This is exactly what the UI does for "Break on Value Change".
      const watch = await client.request('evaluate', {
        expression: 'watch counter',
        context: 'repl',
      });
      const watchOutput = String(watch.result ?? '');
      let watchNumber = parseWatchpointNumber(watchOutput);
      if (watchNumber === null) {
        const info = await client.request('evaluate', {
          expression: 'info watchpoints',
          context: 'repl',
        });
        watchNumber = parseWatchpointList(String(info.result ?? ''), 'counter');
      }
      assert.ok(watchNumber !== null, `no watchpoint number in ${JSON.stringify(watchOutput)}`);

      const continue1 = client.request('continue', { threadId: atMain.body.threadId });
      await continue1;
      const hit = await client.waitEvent(
        'stopped',
        (message) => String(message.body?.reason) === 'data breakpoint',
      );
      const stack = await client.request('stackTrace', { threadId: hit.body.threadId });
      assert.ok(stack.stackFrames.length > 0);

      // Remove the watchpoint through the same command the UI uses.
      await client.request('evaluate', {
        expression: `delete ${watchNumber}`,
        context: 'repl',
      });
      await client.request('continue', { threadId: hit.body.threadId });
      const exited = await client.waitEvent('exited');
      assert.equal(exited.body?.exitCode, 0);

      await client.request('disconnect', {});
      await client.waitControl('gdbExited');
    } finally {
      await client.close();
    }
  });
});

test('attaches to a running process and reports it through DAP', async () => {
  const target: ChildProcess = spawn('sleep', ['30'], { stdio: 'ignore' });
  assert.ok(target.pid);

  try {
    await withServer(async (server) => {
      const client = await DapClient.connect(`ws://127.0.0.1:${server.port}/ws/dap`);
      try {
        client.control('start', { gdbPath: 'gdb', program: DEMO_BINARY, cwd: DEMO_DIR });
        await client.waitControl('started');
        await client.request('initialize', demoClientCapabilities());
        await client.waitEvent('initialized');
        await client.request('evaluate', { expression: 'set confirm off', context: 'repl' });

        const attachPromise = client.request('attach', {
          program: DEMO_BINARY,
          pid: target.pid,
        });
        const configurationDone = client.request('configurationDone', {});
        await configurationDone;
        await attachPromise;

        const stopped = await client.waitEvent('stopped');
        assert.ok(stopped.body?.threadId > 0);
        const threads = await client.request('threads', {});
        assert.ok(threads.threads.length >= 1);

        await client.request('disconnect', { terminateDebuggee: true });
        await client.waitControl('gdbExited');
      } finally {
        await client.close();
      }
    });
    await waitForExit(target, 5000);
  } finally {
    if (target.exitCode === null && target.signalCode === null) {
      target.kill('SIGKILL');
    }
  }
});

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('the attached process was not terminated by the debugger'));
    }, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
