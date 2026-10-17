import { api, dapSocketUrl } from '../api.ts';
import { DapClient, extractAddress } from '../dap/client.ts';
import type {
  Breakpoint,
  Capabilities,
  DisassembledInstruction,
  Scope,
  StackFrame,
  Variable,
} from '../dap/protocol.ts';
import type { NormalizedLaunchConfig } from '../../shared/types.ts';
import {
  WATCHPOINT_ACCESS,
  parseWatchpointList,
  parseWatchpointNumber,
  watchpointAccessLabel,
  watchpointCommand,
  type WatchpointAccess,
} from '../../shared/watchpoints.ts';
import { stopKindLabel, trimmedOrUndefined } from './format.ts';
import {
  beginSession,
  currentGeneration,
  endSession,
  getActiveClient,
  getFileText,
  nextId,
  setActiveClient,
  type GetState,
  type SetState,
} from './runtime.ts';
import type {
  DataBreakpoint,
  EditorTab,
  ExceptionFilterState,
  FunctionBreakpoint,
  InlineValue,
  InstructionBreakpoint,
  InstructionInfo,
  ScopeInfo,
  SourceBreakpoint,
  StackFrameInfo,
  StopKind,
  VariableNode,
  WatchItem,
} from './types.ts';

const PAGE_SIZE = 100;
const FRAME_PAGE = 20;
const DISASSEMBLY_PAGE = 200;
const MEMORY_PAGE_BYTES = 256;
const MAX_CONSOLE_LINES = 5000;
const MAX_OUTPUT_LINES = 2000;
const AUTO_EXPANDED_SCOPES = new Set(['locals', 'arguments', 'returnValue']);

export function createDebugController(set: SetState, get: GetState) {
  const refExpressions = new Map<number, string>();
  const syncQueues = new Map<string, Promise<void>>();
  const unsubscribers: Array<() => void> = [];
  let runToCursorPending = false;
  let lastThreadId: number | null = null;

  // Terminal output is batched so a chatty inferior does not trigger a React
  // render per pty read.
  let terminalPending: string[] = [];
  let terminalFlushTimer: ReturnType<typeof setTimeout> | null = null;

  function enqueueTerminalChunk(base64: string): void {
    terminalPending.push(base64);
    if (terminalFlushTimer !== null) {
      return;
    }
    terminalFlushTimer = setTimeout(() => {
      terminalFlushTimer = null;
      const pending = terminalPending;
      terminalPending = [];
      if (pending.length === 0) {
        return;
      }
      set((state) => {
        let chunks = state.terminal.chunks.concat(pending);
        let epoch = state.terminal.epoch;
        if (chunks.length > 20000) {
          // Drop the scrollback instead of growing without bound.
          chunks = [];
          epoch += 1;
        }
        return { terminal: { ...state.terminal, chunks, epoch } };
      });
    }, 16);
  }

  function resetTerminalPending(): void {
    terminalPending = [];
    if (terminalFlushTimer !== null) {
      clearTimeout(terminalFlushTimer);
      terminalFlushTimer = null;
    }
  }

  function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    const block = 0x8000;
    for (let index = 0; index < bytes.length; index += block) {
      binary += String.fromCharCode(...bytes.subarray(index, index + block));
    }
    return btoa(binary);
  }

  // --------------------------------------------------------- data breakpoints --

  function requirePausedForWatchpoints(action: string): boolean {
    if (get().status !== 'stopped') {
      get().notify({
        severity: 'warning',
        message: `Pause the program to ${action} data breakpoints.`,
        detail:
          'gdb resolves watchpoint expressions in the current frame, so data breakpoints can only be managed while paused.',
      });
      return false;
    }
    return true;
  }

  async function createWatchpointNumber(
    dap: DapClient,
    expression: string,
    access: WatchpointAccess,
  ): Promise<number> {
    const response = await dap.request<{ result: string }>(
      'evaluate',
      { expression: watchpointCommand(access, expression), context: 'repl' },
      15000,
    );
    const output = String(response.result ?? '');
    let number = parseWatchpointNumber(output);
    if (number === null) {
      const info = await dap.request<{ result: string }>(
        'evaluate',
        { expression: 'info watchpoints', context: 'repl' },
        15000,
      );
      number = parseWatchpointList(String(info.result ?? ''), expression);
    }
    if (number === null) {
      throw new Error(
        output.trim() || `gdb did not report a watchpoint number for "${expression}"`,
      );
    }
    if (output.trim().length > 0) {
      appendConsole('console', output.trim());
    }
    return number;
  }

  async function addDataBreakpoint(expression: string, access: WatchpointAccess): Promise<void> {
    const target = expression.trim();
    if (!target || !requirePausedForWatchpoints('create')) {
      return;
    }
    const dap = getActiveClient();
    if (!dap) {
      return;
    }
    const existing = get().dataBreakpoints.find(
      (breakpoint) => breakpoint.expression === target && breakpoint.access === access,
    );
    if (existing?.enabled && existing.verified) {
      get().notify({
        severity: 'info',
        message: `A data breakpoint for "${target}" already exists.`,
      });
      return;
    }
    try {
      const number = await createWatchpointNumber(dap, target, access);
      const frame = selectedFrame();
      const item: DataBreakpoint = {
        id: existing?.id ?? nextId('data'),
        expression: target,
        access,
        enabled: true,
        verified: true,
        adapterId: number,
        sourcePath: frame?.sourcePath,
        line: frame?.line,
      };
      set((state) => ({
        dataBreakpoints: existing
          ? state.dataBreakpoints.map((breakpoint) =>
              breakpoint.id === existing.id ? item : breakpoint,
            )
          : [...state.dataBreakpoints, item],
      }));
      appendConsole(
        'console',
        `${watchpointAccessLabel(access)} watchpoint: ${target} (#${number})`,
      );
    } catch (error) {
      notifyError(`Could not set data breakpoint on "${target}"`, errorText(error));
    }
  }

  async function promptAddDataBreakpoint(expression?: string): Promise<void> {
    if (!requirePausedForWatchpoints('add')) {
      return;
    }
    const chooseAccess = (target: string): void => {
      get().setQuickInput({
        title: `Data Breakpoint: ${target}`,
        placeholder: 'Choose when to stop',
        value: '',
        items: (['write', 'read', 'readWrite'] as WatchpointAccess[]).map((access) => ({
          label: WATCHPOINT_ACCESS[access].label,
          description: WATCHPOINT_ACCESS[access].description,
          icon: 'debug-breakpoint-data',
          action: () => {
            get().setQuickInput(null);
            void addDataBreakpoint(target, access);
          },
        })),
        onSubmit: () => undefined,
      });
    };

    const trimmed = expression?.trim();
    if (trimmed) {
      chooseAccess(trimmed);
      return;
    }
    get().setQuickInput({
      title: 'Add Data Breakpoint',
      prompt: 'The program must be paused so gdb can resolve the expression.',
      placeholder: 'Expression, e.g. counter',
      value: '',
      onSubmit: (value) => {
        const target = value.trim();
        if (target) {
          chooseAccess(target);
        }
      },
    });
  }

  async function removeDataBreakpoint(id: string): Promise<void> {
    const breakpoint = get().dataBreakpoints.find((entry) => entry.id === id);
    if (!breakpoint) {
      return;
    }
    const dap = getActiveClient();
    if (breakpoint.adapterId !== undefined) {
      if (!requirePausedForWatchpoints('remove')) {
        return;
      }
      if (dap) {
        try {
          await dap.request(
            'evaluate',
            { expression: `delete ${breakpoint.adapterId}`, context: 'repl' },
            10000,
          );
        } catch (error) {
          notifyError('Could not remove data breakpoint', errorText(error));
          return;
        }
      }
    }
    set((state) => ({
      dataBreakpoints: state.dataBreakpoints.filter((entry) => entry.id !== id),
      hitDataBreakpointId:
        state.hitDataBreakpointId === id ? null : state.hitDataBreakpointId,
    }));
    appendConsole('console', `Removed data breakpoint: ${breakpoint.expression}`);
  }

  async function setDataBreakpointEnabled(id: string, enabled: boolean): Promise<void> {
    const breakpoint = get().dataBreakpoints.find((entry) => entry.id === id);
    if (!breakpoint || breakpoint.enabled === enabled) {
      return;
    }
    if (!requirePausedForWatchpoints(enabled ? 'enable' : 'disable')) {
      return;
    }
    const dap = getActiveClient();
    if (enabled) {
      if (!dap) {
        return;
      }
      try {
        const number = await createWatchpointNumber(dap, breakpoint.expression, breakpoint.access);
        set((state) => ({
          dataBreakpoints: state.dataBreakpoints.map((entry) =>
            entry.id === id
              ? { ...entry, enabled: true, verified: true, adapterId: number, message: undefined }
              : entry,
          ),
        }));
      } catch (error) {
        notifyError('Could not enable data breakpoint', errorText(error));
      }
      return;
    }

    if (breakpoint.adapterId !== undefined && dap) {
      try {
        await dap.request(
          'evaluate',
          { expression: `delete ${breakpoint.adapterId}`, context: 'repl' },
          10000,
        );
      } catch (error) {
        notifyError('Could not disable data breakpoint', errorText(error));
        return;
      }
    }
    set((state) => ({
      dataBreakpoints: state.dataBreakpoints.map((entry) =>
        entry.id === id
          ? { ...entry, enabled: false, verified: false, adapterId: undefined }
          : entry,
      ),
    }));
  }

  async function removeAllDataBreakpoints(): Promise<void> {
    const breakpoints = get().dataBreakpoints;
    if (breakpoints.length === 0) {
      return;
    }
    if (!requirePausedForWatchpoints('remove')) {
      return;
    }
    const dap = getActiveClient();
    const ids = breakpoints
      .map((breakpoint) => breakpoint.adapterId)
      .filter((id): id is number => typeof id === 'number');
    if (dap && ids.length > 0) {
      try {
        await dap.request(
          'evaluate',
          { expression: `delete ${ids.join(' ')}`, context: 'repl' },
          15000,
        );
      } catch (error) {
        notifyError('Could not remove data breakpoints', errorText(error));
        return;
      }
    }
    set({ dataBreakpoints: [], hitDataBreakpointId: null });
    appendConsole(
      'console',
      `Removed ${breakpoints.length} data breakpoint${breakpoints.length === 1 ? '' : 's'}.`,
    );
  }

  // ---------------------------------------------------------------- output --

  function appendConsole(kind: 'input' | 'stdout' | 'stderr' | 'console' | 'info' | 'error' | 'result', text: string): void {
    if (text.length === 0) {
      return;
    }
    set((state) => ({
      consoleLines: [
        ...state.consoleLines,
        { id: nextId('line'), kind, text, time: Date.now() },
      ].slice(-MAX_CONSOLE_LINES),
    }));
  }

  function appendOutput(text: string, kind: 'info' | 'error' | 'console' = 'info'): void {
    set((state) => ({
      outputLines: [
        ...state.outputLines,
        { id: nextId('out'), kind, text, time: Date.now() },
      ].slice(-MAX_OUTPUT_LINES),
    }));
  }

  function notifyError(message: string, detail?: string): void {
    get().notify({ severity: 'error', message, detail });
  }

  function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  // ------------------------------------------------------------ session prep --

  function detachSession(): void {
    for (const unsubscribe of unsubscribers.splice(0)) {
      unsubscribe();
    }
    const dap = getActiveClient();
    setActiveClient(null);
    dap?.close();
    endSession();
  }

  function selectedFrame(): StackFrameInfo | undefined {
    const state = get();
    return state.frames.find((frame) => frame.id === state.selectedFrameId);
  }

  function mapSourcePath(adapterPath: string | undefined): string | undefined {
    if (!adapterPath) {
      return undefined;
    }
    const map = get().activeConfig?.sourceFileMap;
    if (!map) {
      return adapterPath;
    }
    let bestFrom: string | null = null;
    let bestTo = '';
    for (const [from, to] of Object.entries(map)) {
      const normalizedFrom = from.replace(/\/+$/, '');
      if (adapterPath === normalizedFrom || adapterPath.startsWith(normalizedFrom + '/')) {
        if (!bestFrom || normalizedFrom.length > bestFrom.length) {
          bestFrom = normalizedFrom;
          bestTo = to.replace(/\/+$/, '');
        }
      }
    }
    return bestFrom ? bestTo + adapterPath.slice(bestFrom.length) : adapterPath;
  }

  function toStackFrameInfo(frame: StackFrame): StackFrameInfo {
    return {
      id: frame.id,
      name: frame.name,
      line: frame.line ?? 0,
      column: frame.column ?? 0,
      sourcePath: mapSourcePath(frame.source?.path),
      sourceName: frame.source?.name,
      instructionPointerReference: frame.instructionPointerReference,
      moduleId: frame.moduleId,
    };
  }

  function launchArguments(config: NormalizedLaunchConfig, pid?: number): Record<string, unknown> {
    if (config.request === 'attach') {
      const args: Record<string, unknown> = {};
      if (config.program) {
        args.program = config.program;
      }
      if (pid !== undefined) {
        args.pid = pid;
      }
      if (config.target) {
        args.target = config.target;
      }
      return args;
    }
    const args: Record<string, unknown> = {
      program: config.program,
      cwd: config.cwd,
      args: config.args,
    };
    if (config.env) {
      args.env = config.env;
    }
    if (config.stopAtBeginningOfMainSubprogram) {
      args.stopAtBeginningOfMainSubprogram = true;
    }
    if (config.stopOnEntry) {
      args.stopOnEntry = true;
    }
    return args;
  }

  function clientCapabilities(): Record<string, unknown> {
    return {
      clientID: 'gdb-client',
      clientName: 'gdb-client',
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

  async function runSetupCommands(
    dap: DapClient,
    config: NormalizedLaunchConfig,
    ttyPath?: string,
  ): Promise<void> {
    const commands = [
      { text: 'set confirm off', description: 'Disable confirmation prompts', ignoreFailures: false },
      ...(ttyPath
        ? [
            {
              text: `set inferior-tty ${ttyPath}`,
              description: 'Attach the inferior to the integrated terminal',
              ignoreFailures: false,
            },
          ]
        : []),
      ...config.setupCommands,
    ];
    for (const command of commands) {
      try {
        await dap.request('evaluate', { expression: command.text, context: 'repl' }, 15000);
      } catch (error) {
        const message = `setup command failed (${command.text}): ${errorText(error)}`;
        if (command.ignoreFailures) {
          appendConsole('console', message);
        } else {
          throw new Error(message);
        }
      }
    }
  }

  function applyExceptionFilterCapabilities(capabilities: Capabilities): void {
    const previous = get().exceptionFilters;
    const available = capabilities.exceptionBreakpointFilters ?? [];
    const filters: ExceptionFilterState[] = available.map((filter) => {
      const existing = previous.find((entry) => entry.filter === filter.filter);
      return {
        filter: filter.filter,
        label: filter.label,
        enabled: existing?.enabled ?? false,
        supportsCondition: filter.supportsCondition ?? false,
        condition: existing?.condition,
      };
    });
    set({ exceptionFilters: filters });
  }

  // ------------------------------------------------------------ breakpoints --

  function updateSourceBreakpoints(path: string, updater: (list: SourceBreakpoint[]) => SourceBreakpoint[]): void {
    set((state) => ({
      breakpoints: {
        ...state.breakpoints,
        [path]: updater(state.breakpoints[path] ?? []),
      },
    }));
  }

  function updateFunctionBreakpoints(updater: (list: FunctionBreakpoint[]) => FunctionBreakpoint[]): void {
    set((state) => ({ functionBreakpoints: updater(state.functionBreakpoints) }));
  }

  function updateInstructionBreakpoints(
    updater: (list: InstructionBreakpoint[]) => InstructionBreakpoint[],
  ): void {
    set((state) => ({ instructionBreakpoints: updater(state.instructionBreakpoints) }));
  }

  function findSourceBreakpoint(id: string): { path: string; breakpoint: SourceBreakpoint } | null {
    for (const [path, list] of Object.entries(get().breakpoints)) {
      const breakpoint = list.find((entry) => entry.id === id);
      if (breakpoint) {
        return { path, breakpoint };
      }
    }
    return null;
  }

  function breakpointPayload(breakpoint: SourceBreakpoint): Record<string, unknown> {
    const payload: Record<string, unknown> = { line: breakpoint.line };
    if (breakpoint.condition) {
      payload.condition = breakpoint.condition;
    }
    if (breakpoint.hitCondition) {
      payload.hitCondition = breakpoint.hitCondition;
    }
    if (breakpoint.logMessage) {
      payload.logMessage = breakpoint.logMessage;
    }
    return payload;
  }

  async function doSyncSourceFile(path: string): Promise<void> {
    const dap = getActiveClient();
    if (!dap) {
      return;
    }
    const list = get().breakpoints[path] ?? [];
    const enabled = list.filter((breakpoint) => breakpoint.enabled);
    if (enabled.length === 0) {
      await dap.request('setBreakpoints', { source: { path }, breakpoints: [] });
      updateSourceBreakpoints(path, (current) =>
        current.map((breakpoint) => ({
          ...breakpoint,
          adapterId: undefined,
          verified: false,
          message: undefined,
        })),
      );
      return;
    }
    const response = await dap.request<{ breakpoints: Breakpoint[] }>('setBreakpoints', {
      source: { path },
      breakpoints: enabled.map(breakpointPayload),
    });
    updateSourceBreakpoints(path, (current) =>
      current.map((breakpoint) => {
        if (!breakpoint.enabled) {
          return { ...breakpoint, adapterId: undefined };
        }
        const index = enabled.findIndex((entry) => entry.id === breakpoint.id);
        const adapterBreakpoint = index >= 0 ? response.breakpoints[index] : undefined;
        return {
          ...breakpoint,
          verified: adapterBreakpoint?.verified ?? false,
          message: adapterBreakpoint?.message,
          adapterId: adapterBreakpoint?.id,
          instructionReference: adapterBreakpoint?.instructionReference ?? breakpoint.instructionReference,
        };
      }),
    );
  }

  function syncSourceFile(path: string): Promise<void> {
    const previous = syncQueues.get(path) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => doSyncSourceFile(path));
    syncQueues.set(path, next);
    return next;
  }

  async function syncFunctionBreakpoints(): Promise<void> {
    const dap = getActiveClient();
    if (!dap) {
      return;
    }
    const enabled = get().functionBreakpoints.filter((breakpoint) => breakpoint.enabled);
    if (enabled.length === 0) {
      await dap.request('setFunctionBreakpoints', { breakpoints: [] });
      updateFunctionBreakpoints((list) =>
        list.map((breakpoint) => ({ ...breakpoint, adapterId: undefined, verified: false })),
      );
      return;
    }
    const response = await dap.request<{ breakpoints: Breakpoint[] }>('setFunctionBreakpoints', {
      breakpoints: enabled.map((breakpoint) => ({
        name: breakpoint.name,
        ...(breakpoint.condition ? { condition: breakpoint.condition } : {}),
        ...(breakpoint.hitCondition ? { hitCondition: breakpoint.hitCondition } : {}),
      })),
    });
    updateFunctionBreakpoints((list) =>
      list.map((breakpoint) => {
        if (!breakpoint.enabled) {
          return { ...breakpoint, adapterId: undefined };
        }
        const index = enabled.findIndex((entry) => entry.id === breakpoint.id);
        const adapterBreakpoint = response.breakpoints[index];
        return {
          ...breakpoint,
          verified: adapterBreakpoint?.verified ?? false,
          message: adapterBreakpoint?.message,
          adapterId: adapterBreakpoint?.id,
        };
      }),
    );
  }

  async function syncInstructionBreakpoints(): Promise<void> {
    const dap = getActiveClient();
    if (!dap) {
      return;
    }
    const enabled = get().instructionBreakpoints.filter((breakpoint) => breakpoint.enabled);
    if (enabled.length === 0) {
      await dap.request('setInstructionBreakpoints', { breakpoints: [] });
      updateInstructionBreakpoints((list) =>
        list.map((breakpoint) => ({ ...breakpoint, adapterId: undefined, verified: false })),
      );
      return;
    }
    const response = await dap.request<{ breakpoints: Breakpoint[] }>('setInstructionBreakpoints', {
      breakpoints: enabled.map((breakpoint) => ({
        instructionReference: breakpoint.instructionReference,
        ...(breakpoint.offset !== undefined ? { offset: breakpoint.offset } : {}),
        ...(breakpoint.condition ? { condition: breakpoint.condition } : {}),
        ...(breakpoint.hitCondition ? { hitCondition: breakpoint.hitCondition } : {}),
      })),
    });
    updateInstructionBreakpoints((list) =>
      list.map((breakpoint) => {
        if (!breakpoint.enabled) {
          return { ...breakpoint, adapterId: undefined };
        }
        const index = enabled.findIndex((entry) => entry.id === breakpoint.id);
        const adapterBreakpoint = response.breakpoints[index];
        return {
          ...breakpoint,
          verified: adapterBreakpoint?.verified ?? false,
          message: adapterBreakpoint?.message,
          adapterId: adapterBreakpoint?.id,
          sourcePath: mapSourcePath(adapterBreakpoint?.source?.path) ?? breakpoint.sourcePath,
          line: adapterBreakpoint?.line ?? breakpoint.line,
        };
      }),
    );
  }

  async function syncExceptionBreakpoints(): Promise<void> {
    const dap = getActiveClient();
    if (!dap) {
      return;
    }
    const enabled = get().exceptionFilters.filter((filter) => filter.enabled);
    const plain = enabled.filter((filter) => !filter.condition).map((filter) => filter.filter);
    const withCondition = enabled
      .filter((filter) => filter.condition)
      .map((filter) => ({ filterId: filter.filter, condition: filter.condition }));
    const response = await dap.request<{ breakpoints: Breakpoint[] }>('setExceptionBreakpoints', {
      filters: plain,
      filterOptions: withCondition,
    });
    const ordered = [
      ...enabled.filter((filter) => !filter.condition),
      ...enabled.filter((filter) => filter.condition),
    ];
    const ids = new Map<string, number | undefined>();
    ordered.forEach((filter, index) => {
      ids.set(filter.filter, response.breakpoints[index]?.id);
    });
    set((state) => ({
      exceptionFilters: state.exceptionFilters.map((filter) => ({
        ...filter,
        adapterId: filter.enabled ? ids.get(filter.filter) : undefined,
      })),
    }));
  }

  async function syncEveryBreakpoint(): Promise<void> {
    const paths = Object.entries(get().breakpoints)
      .filter(([, list]) => list.some((breakpoint) => breakpoint.enabled))
      .map(([path]) => path);
    for (const path of paths) {
      await syncSourceFile(path);
    }
    await syncFunctionBreakpoints();
    await syncInstructionBreakpoints();
    await syncExceptionBreakpoints();
  }

  function reportSyncFailure(error: unknown, context: string): void {
    notifyError(`Breakpoint update failed: ${context}`, errorText(error));
  }

  // --------------------------------------------------------------- session --

  function classifyStop(body: any): StopKind {
    const hit: number[] = Array.isArray(body?.hitBreakpointIds) ? body.hitBreakpointIds : [];
    const exceptionIds = new Set(
      get()
        .exceptionFilters.map((filter) => filter.adapterId)
        .filter((id): id is number => typeof id === 'number'),
    );
    if (hit.some((id) => exceptionIds.has(id))) {
      return 'exception';
    }
    const reason = String(body?.reason ?? '');
    if (reason === 'breakpoint') {
      const known = new Set<number>();
      for (const list of Object.values(get().breakpoints)) {
        for (const breakpoint of list) {
          if (breakpoint.adapterId !== undefined) {
            known.add(breakpoint.adapterId);
          }
        }
      }
      for (const breakpoint of get().functionBreakpoints) {
        if (breakpoint.adapterId !== undefined) {
          known.add(breakpoint.adapterId);
        }
      }
      for (const breakpoint of get().instructionBreakpoints) {
        if (breakpoint.adapterId !== undefined) {
          known.add(breakpoint.adapterId);
        }
      }
      if (hit.length > 0 && !hit.some((id) => known.has(id))) {
        return 'entry';
      }
      return 'breakpoint';
    }
    if (reason === 'signal' && get().activeConfig?.stopOnEntry) {
      return 'entry';
    }
    if (
      reason === 'step' ||
      reason === 'pause' ||
      reason === 'exception' ||
      reason === 'signal' ||
      reason === 'data breakpoint'
    ) {
      return reason as StopKind;
    }
    return 'other';
  }

  async function handleStopped(body: any): Promise<void> {
    const hitIds: number[] = Array.isArray(body?.hitBreakpointIds) ? body.hitBreakpointIds : [];
    let hitData = get().dataBreakpoints.find(
      (breakpoint) => breakpoint.adapterId !== undefined && hitIds.includes(breakpoint.adapterId),
    );
    if (
      !hitData &&
      String(body?.reason ?? '') === 'data breakpoint' &&
      get().dataBreakpoints.filter((breakpoint) => breakpoint.enabled).length === 1
    ) {
      // gdb does not always include watchpoints in hitBreakpointIds; with a
      // single active data breakpoint the attribution is unambiguous.
      hitData = get().dataBreakpoints.find((breakpoint) => breakpoint.enabled);
    }
    const stopKind = hitData ? 'data breakpoint' : classifyStop(body);
    set({
      status: 'stopped',
      stopReason: String(body?.reason ?? ''),
      stopDescription: body?.description ? String(body.description) : null,
      stopKind,
      statusMessage: stopKindLabel(stopKind),
      hitDataBreakpointId: hitData?.id ?? null,
    });
    lastThreadId = typeof body?.threadId === 'number' ? body.threadId : null;

    if (runToCursorPending) {
      runToCursorPending = false;
      const tempPaths = new Set<string>();
      for (const [path, list] of Object.entries(get().breakpoints)) {
        if (list.some((breakpoint) => breakpoint.temporary)) {
          tempPaths.add(path);
          updateSourceBreakpoints(path, (current) => current.filter((breakpoint) => !breakpoint.temporary));
        }
      }
      for (const path of tempPaths) {
        await syncSourceFile(path).catch((error) => reportSyncFailure(error, 'remove run-to-cursor breakpoint'));
      }
    }

    try {
      const dap = getActiveClient();
      if (!dap) {
        return;
      }
      const threads = await dap.request<{ threads: { id: number; name: string }[] }>('threads', {});
      set({
        threads: threads.threads.map((thread) => ({ id: thread.id, name: thread.name })),
        currentThreadId: lastThreadId ?? threads.threads[0]?.id ?? null,
      });
      if (get().currentThreadId !== null) {
        await loadFrames(get().currentThreadId as number, false);
      }
      // VS Code reveals the stopped location automatically.
      const frame = selectedFrame();
      if (frame?.sourcePath && frame.line > 0) {
        await get().openSource(frame.sourcePath, frame.line, { pinned: true });
      }
    } catch (error) {
      appendConsole('error', `failed to read the stopped state: ${errorText(error)}`);
    }

    const disassemblyTab = get().editorTabs.find((tab) => tab.kind === 'disassembly');
    if (disassemblyTab?.disassembly?.follow) {
      await loadDisassembly(disassemblyTab.id).catch(() => undefined);
    }
    const memoryTab = get().editorTabs.find((tab) => tab.kind === 'memory');
    if (memoryTab) {
      await get().reloadMemory(memoryTab.id).catch(() => undefined);
    }
  }

  function handleContinued(body: any): void {
    lastThreadId = typeof body?.threadId === 'number' ? body.threadId : lastThreadId;
    set({
      status: 'running',
      statusMessage: 'Running',
      stopKind: null,
      stopReason: null,
      stopDescription: null,
      hitDataBreakpointId: null,
      frames: [],
      framesHasMore: false,
      selectedFrameId: null,
      scopes: [],
      variables: {},
      expandedRefs: {},
      inlineValues: [],
      watches: get().watches.map((watch) => ({
        ...watch,
        value: undefined,
        type: undefined,
        variablesReference: undefined,
        error: undefined,
        evaluating: false,
      })),
    });
    refExpressions.clear();
  }

  function handleExited(body: any): void {
    set((state) => ({
      status: 'terminated',
      statusMessage: 'Terminated',
      exitCode: typeof body?.exitCode === 'number' ? body.exitCode : null,
      frames: [],
      framesHasMore: false,
      selectedFrameId: null,
      scopes: [],
      variables: {},
      expandedRefs: {},
      inlineValues: [],
      stopKind: null,
      threads: [],
      dataBreakpoints: [],
      hitDataBreakpointId: null,
      terminal: { ...state.terminal, exited: true },
    }));
    appendConsole('info', `Process exited with code ${body?.exitCode ?? 'unknown'}.`);
  }

  function handleBreakpointEvent(body: any): void {
    const adapterBreakpoint: Breakpoint | undefined = body?.breakpoint;
    if (!adapterBreakpoint || typeof adapterBreakpoint.id !== 'number') {
      return;
    }
    const adapterId = adapterBreakpoint.id;
    if (body.reason === 'removed') {
      removeAdapterBreakpoint(adapterId);
      return;
    }
    let matched = false;
    set((state) => {
      const nextBreakpoints: Record<string, SourceBreakpoint[]> = { ...state.breakpoints };
      for (const [path, list] of Object.entries(nextBreakpoints)) {
        if (list.some((breakpoint) => breakpoint.adapterId === adapterId)) {
          nextBreakpoints[path] = list.map((breakpoint) =>
            breakpoint.adapterId === adapterId
              ? {
                  ...breakpoint,
                  verified: adapterBreakpoint.verified,
                  message: adapterBreakpoint.message,
                  line: adapterBreakpoint.line ?? breakpoint.line,
                  instructionReference:
                    adapterBreakpoint.instructionReference ?? breakpoint.instructionReference,
                }
              : breakpoint,
          );
          matched = true;
        }
      }
      const functionBreakpoints = state.functionBreakpoints.map((breakpoint) =>
        breakpoint.adapterId === adapterId
          ? {
              ...breakpoint,
              verified: adapterBreakpoint.verified,
              message: adapterBreakpoint.message,
            }
          : breakpoint,
      );
      if (functionBreakpoints.some((breakpoint) => breakpoint.adapterId === adapterId)) {
        matched = true;
      }
      const instructionBreakpoints = state.instructionBreakpoints.map((breakpoint) =>
        breakpoint.adapterId === adapterId
          ? {
              ...breakpoint,
              verified: adapterBreakpoint.verified,
              message: adapterBreakpoint.message,
              sourcePath: mapSourcePath(adapterBreakpoint.source?.path) ?? breakpoint.sourcePath,
              line: adapterBreakpoint.line ?? breakpoint.line,
            }
          : breakpoint,
      );
      if (instructionBreakpoints.some((breakpoint) => breakpoint.adapterId === adapterId)) {
        matched = true;
      }
      return { breakpoints: nextBreakpoints, functionBreakpoints, instructionBreakpoints };
    });
    if (!matched) {
      // A breakpoint created outside this UI (e.g. a catchpoint) is not mirrored.
      return;
    }
  }

  function removeAdapterBreakpoint(adapterId: number): void {
    set((state) => {
      const breakpoints: Record<string, SourceBreakpoint[]> = {};
      for (const [path, list] of Object.entries(state.breakpoints)) {
        breakpoints[path] = list.filter((breakpoint) => breakpoint.adapterId !== adapterId);
      }
      return {
        breakpoints,
        functionBreakpoints: state.functionBreakpoints.filter(
          (breakpoint) => breakpoint.adapterId !== adapterId,
        ),
        instructionBreakpoints: state.instructionBreakpoints.filter(
          (breakpoint) => breakpoint.adapterId !== adapterId,
        ),
      };
    });
  }

  async function handleThreadEvent(): Promise<void> {
    if (get().status !== 'stopped') {
      return;
    }
    const dap = getActiveClient();
    if (!dap) {
      return;
    }
    try {
      const threads = await dap.request<{ threads: { id: number; name: string }[] }>('threads', {});
      set({ threads: threads.threads.map((thread) => ({ id: thread.id, name: thread.name })) });
    } catch {
      // Thread list refreshes are best effort.
    }
  }

  function wireSession(dap: DapClient, generation: number): void {
    const guard = <Args extends unknown[]>(fn: (...args: Args) => void) => {
      return (...args: Args) => {
        if (generation === currentGeneration()) {
          fn(...args);
        }
      };
    };
    unsubscribers.push(
      dap.onEvent('stopped', guard((body) => void handleStopped(body))),
      dap.onEvent('continued', guard(handleContinued)),
      dap.onEvent('exited', guard(handleExited)),
      dap.onEvent(
        'terminated',
        guard(() => {
          if (get().status !== 'inactive') {
            set({ status: 'terminated', statusMessage: 'Terminated' });
          }
        }),
      ),
      dap.onEvent('thread', guard(() => void handleThreadEvent())),
      dap.onEvent('breakpoint', guard(handleBreakpointEvent)),
      dap.onEvent(
        'output',
        guard((body) => {
          const category = String(body?.category ?? 'console');
          const text = String(body?.output ?? '');
          if (!text) {
            return;
          }
          if (category === 'stderr') {
            appendConsole('stderr', text);
          } else if (category === 'stdout') {
            appendConsole('stdout', text);
          } else if (category === 'console') {
            appendConsole('console', text);
          } else {
            appendConsole('info', text);
          }
        }),
      ),
      dap.onEvent(
        'process',
        guard((body) => {
          if (typeof body?.systemProcessId === 'number') {
            set({ processId: body.systemProcessId });
          }
        }),
      ),
      dap.onEvent(
        'capabilities',
        guard((body) => {
          set({ capabilities: { ...(get().capabilities ?? {}), ...(body as Capabilities) } });
        }),
      ),
      dap.onControl(
        'gdbStderr',
        guard((_event, body) => {
          const text = String(body?.text ?? '');
          if (text.trim().length > 0) {
            appendOutput(text.trimEnd());
          }
        }),
      ),
      dap.onControl(
        'gdbExited',
        guard((_event, body) => {
          appendConsole('info', `gdb exited (code ${body?.code ?? '?'}).`);
          if (get().status !== 'inactive') {
            const expected = get().status === 'terminated';
            set((state) => ({
              status: 'inactive',
              statusMessage: null,
              threads: [],
              frames: [],
              scopes: [],
              variables: {},
              inlineValues: [],
              stopKind: null,
              dataBreakpoints: [],
              hitDataBreakpointId: null,
              terminal: { ...state.terminal, exited: true },
            }));
            if (!expected && body?.code !== 0) {
              notifyError(`gdb exited unexpectedly (code ${body?.code ?? '?'})`);
            }
          }
          detachSession();
        }),
      ),
      dap.onControl(
        'terminalData',
        guard((_event, body) => {
          if (typeof body?.data === 'string') {
            enqueueTerminalChunk(body.data);
          }
        }),
      ),
      dap.onControl(
        'terminalExit',
        guard(() => {
          set((state) => ({ terminal: { ...state.terminal, exited: true } }));
        }),
      ),
      dap.onControl(
        'terminalError',
        guard((_event, body) => {
          const message = String(body?.message ?? 'integrated terminal error');
          appendConsole('error', message);
          set((state) => ({ terminal: { ...state.terminal, error: message } }));
        }),
      ),
      dap.onControl(
        'error',
        guard((_event, body) => {
          const message = String(body?.message ?? 'debug adapter error');
          appendConsole('error', message);
          if (get().status !== 'initializing') {
            notifyError('Debug adapter error', message);
          }
        }),
      ),
      dap.onClose(
        guard(() => {
          if (get().status !== 'inactive') {
            appendOutput('The debug session ended.');
            set((state) => ({
              status: 'inactive',
              statusMessage: null,
              threads: [],
              frames: [],
              scopes: [],
              variables: {},
              inlineValues: [],
              stopKind: null,
              dataBreakpoints: [],
              hitDataBreakpointId: null,
              terminal: { ...state.terminal, exited: true },
            }));
          }
          detachSession();
        }),
      ),
    );
  }

  async function loadFrames(threadId: number, append: boolean): Promise<void> {
    const dap = getActiveClient();
    if (!dap) {
      return;
    }
    const startFrame = append ? get().frames.length : 0;
    try {
      const response = await dap.request<{ stackFrames: StackFrame[] }>(
        'stackTrace',
        { threadId, startFrame, levels: FRAME_PAGE },
        20000,
      );
      const frames = response.stackFrames.map(toStackFrameInfo);
      set((state) => ({
        frames: append ? [...state.frames, ...frames] : frames,
        framesHasMore: frames.length === FRAME_PAGE,
      }));
      if (!append) {
        set({ selectedFrameId: frames[0]?.id ?? null });
        await refreshScopes();
        await refreshWatches();
        await refreshInlineValues();
      }
    } catch (error) {
      appendConsole('error', `could not read the call stack: ${errorText(error)}`);
      if (!append) {
        set({ frames: [], framesHasMore: false, selectedFrameId: null, scopes: [], variables: {} });
      }
    }
  }

  async function startSession(config: NormalizedLaunchConfig, pid?: number): Promise<void> {
    detachSession();
    const generation = beginSession();

    set({
      status: 'initializing',
      activeConfig: config,
      attachPid: pid ?? null,
      capabilities: null,
      sessionError: null,
      exitCode: null,
      processId: null,
      statusMessage: 'Starting gdb…',
      stopKind: null,
      stopReason: null,
      stopDescription: null,
      hitDataBreakpointId: null,
      dataBreakpoints: [],
      threads: [],
      frames: [],
      framesHasMore: false,
      selectedFrameId: null,
      scopes: [],
      variables: {},
      expandedRefs: {},
      inlineValues: [],
      watches: get().watches.map((watch) => ({
        ...watch,
        value: undefined,
        type: undefined,
        variablesReference: undefined,
        error: undefined,
        evaluating: false,
      })),
      consoleLines: [],
      dapTrace: [],
      terminal: {
        available: false,
        slavePath: null,
        chunks: [],
        epoch: get().terminal.epoch + 1,
        exited: false,
        error: null,
        console: config.console,
      },
    });
    resetTerminalPending();
    appendConsole('info', `Starting debug session: ${config.name}`);

    let dap: DapClient | null = null;
    try {
      dap = await DapClient.connect(dapSocketUrl());
      if (generation !== currentGeneration()) {
        dap.close();
        return;
      }
      setActiveClient(dap);
      wireSession(dap, generation);

      let rejectStartup: ((error: Error) => void) | null = null;
      const startupFailure = new Promise<never>((_resolve, reject) => {
        rejectStartup = reject;
      });
      startupFailure.catch(() => undefined);
      const offStartupError = dap.onControl('error', (_event, body) => {
        rejectStartup?.(new Error(String(body?.message ?? 'could not start gdb')));
      });
      const offStartupExit = dap.onControl('gdbExited', () => {
        rejectStartup?.(new Error('gdb exited while the debug session was starting'));
      });

      const terminalRequest =
        config.console === 'integratedTerminal' ? { cols: 100, rows: 30 } : undefined;
      dap.control('start', {
        gdbPath: config.miDebuggerPath,
        gdbArgs: config.miDebuggerArgs,
        program: config.program,
        cwd: config.cwd,
        ...(terminalRequest ? { terminal: terminalRequest } : {}),
      });
      const started = await Promise.race([dap.waitControl('started', 20000), startupFailure]);
      offStartupError();
      offStartupExit();
      const slavePath =
        typeof (started as { terminal?: { slave?: unknown } } | undefined)?.terminal?.slave === 'string'
          ? ((started as { terminal: { slave: string } }).terminal.slave)
          : null;
      set({
        processId: typeof started?.pid === 'number' ? started.pid : null,
        statusMessage: 'Initializing…',
        ...(slavePath
          ? {
              terminal: {
                available: true,
                slavePath,
                chunks: [],
                epoch: get().terminal.epoch,
                exited: false,
                error: null,
                console: config.console,
              },
              panelVisible: true,
              panelTab: 'terminal' as const,
            }
          : {}),
      });

      const initializedPromise = dap.waitEvent('initialized', undefined, 15000);
      const capabilities = await dap.request<Capabilities>('initialize', clientCapabilities());
      if (generation !== currentGeneration()) {
        return;
      }
      set({ capabilities, statusMessage: 'Configuring…' });
      applyExceptionFilterCapabilities(capabilities);
      await initializedPromise;

      const launchPromise = dap.request(
        config.request === 'launch' ? 'launch' : 'attach',
        launchArguments(config, pid),
        60000,
      );
      await runSetupCommands(dap, config, slavePath ?? undefined);
      await syncEveryBreakpoint();
      await dap.request('configurationDone', {}, 60000);
      await launchPromise;
      if (generation !== currentGeneration()) {
        return;
      }
      set({ status: 'running', statusMessage: 'Running' });
      appendConsole('info', 'Program started.');
    } catch (error) {
      if (generation !== currentGeneration()) {
        return;
      }
      const message = errorText(error);
      set({
        status: 'error',
        sessionError: message,
        statusMessage: 'Debug session failed',
        threads: [],
        frames: [],
        scopes: [],
        variables: {},
      });
      appendConsole('error', message);
      notifyError('Debug session failed', message);
      detachSession();
    }
  }

  async function startDebugging(configName?: string, options?: { pid?: number }): Promise<void> {
    const state = get();
    if (state.status === 'initializing' || state.status === 'running' || state.status === 'stopped') {
      get().notify({ severity: 'warning', message: 'A debug session is already running.' });
      return;
    }
    await get().refreshLaunchConfigs(state.focusedFile);
    const launchFile = get().launchFile;
    if (!launchFile) {
      notifyError('Could not read .vscode/launch.json.');
      return;
    }
    if (launchFile.errors.length > 0) {
      notifyError('launch.json contains errors', launchFile.errors.join('\n'));
      return;
    }
    const configs = launchFile.configs;
    if (configs.length === 0) {
      notifyError(
        'No launch configuration found',
        'Create .vscode/launch.json and add a configuration with "request", "program" and "name".',
      );
      return;
    }
    const requested = configName ?? get().selectedConfigName;
    const config = configs.find((entry) => entry.name === requested) ?? configs[0];
    set({ selectedConfigName: config.name });
    for (const warning of config.warnings) {
      get().notify({ severity: 'warning', message: warning });
    }
    let pid = options?.pid ?? config.pid;
    if (
      config.request === 'attach' &&
      pid === undefined &&
      !config.target &&
      config.pickProcess
    ) {
      await get().openProcessPicker(config.name);
      return;
    }
    if (config.request === 'attach' && pid === undefined && !config.target) {
      notifyError('Attach configuration needs a process id or a remote target.');
      return;
    }
    await startSession(config, pid);
  }

  async function stopDebugging(): Promise<void> {
    const dap = getActiveClient();
    // Attach sessions disconnect and leave the target running, like cpptools.
    const terminateDebuggee = get().activeConfig?.request !== 'attach';
    if (dap && !dap.isClosed) {
      try {
        await dap.request('disconnect', { terminateDebuggee }, 5000);
      } catch {
        // gdb may already be gone; closing the socket is enough.
      }
    }
    detachSession();
    set((state) => ({
      status: 'inactive',
      statusMessage: null,
      stopKind: null,
      stopReason: null,
      stopDescription: null,
      threads: [],
      frames: [],
      framesHasMore: false,
      selectedFrameId: null,
      scopes: [],
      variables: {},
      expandedRefs: {},
      inlineValues: [],
      processId: null,
      dataBreakpoints: [],
      hitDataBreakpointId: null,
      terminal: { ...state.terminal, exited: true },
    }));
    appendConsole(
      'info',
      terminateDebuggee
        ? 'Debug session ended.'
        : 'Disconnected from the target; the process was left running.',
    );
  }

  async function restartDebugging(): Promise<void> {
    const config = get().activeConfig;
    const pid = get().attachPid ?? undefined;
    if (!config) {
      return;
    }
    await stopDebugging();
    await startSession(config, pid);
  }

  function currentThreadIdOrNull(): number | null {
    return get().currentThreadId ?? lastThreadId ?? get().threads[0]?.id ?? null;
  }

  function continueExecution(): void {
    const dap = getActiveClient();
    if (!dap || get().status !== 'stopped') {
      return;
    }
    const threadId = currentThreadIdOrNull();
    if (threadId === null) {
      return;
    }
    set({ status: 'running', statusMessage: 'Running' });
    dap.request('continue', { threadId }).catch((error) => {
      set({ status: 'stopped', statusMessage: 'Paused' });
      notifyError('Could not continue', errorText(error));
    });
  }

  function pauseExecution(): void {
    const dap = getActiveClient();
    if (!dap || get().status !== 'running') {
      return;
    }
    try {
      dap.notify('pause');
      set({ statusMessage: 'Pausing…' });
    } catch (error) {
      notifyError('Could not pause', errorText(error));
    }
  }

  function step(granularity: 'statement' | 'instruction', kind: 'next' | 'stepIn'): void {
    const dap = getActiveClient();
    if (!dap || get().status !== 'stopped') {
      return;
    }
    const threadId = currentThreadIdOrNull();
    if (threadId === null) {
      return;
    }
    set({ status: 'running', statusMessage: 'Stepping…', frames: [], scopes: [], variables: {} });
    try {
      dap.notify(kind, { threadId, granularity });
    } catch (error) {
      set({ status: 'stopped' });
      notifyError('Could not step', errorText(error));
    }
  }

  function stepOver(granularity: 'statement' | 'instruction' = 'statement'): void {
    step(granularity, 'next');
  }

  function stepInto(granularity: 'statement' | 'instruction' = 'statement'): void {
    step(granularity, 'stepIn');
  }

  function stepOut(): void {
    const dap = getActiveClient();
    if (!dap || get().status !== 'stopped') {
      return;
    }
    const threadId = currentThreadIdOrNull();
    if (threadId === null) {
      return;
    }
    set({ status: 'running', statusMessage: 'Stepping…', frames: [], scopes: [], variables: {} });
    dap.request('stepOut', { threadId }, 60000).catch((error) => {
      set({ status: 'stopped' });
      notifyError('Could not step out', errorText(error));
    });
  }

  async function runToCursor(path: string, line: number): Promise<void> {
    const dap = getActiveClient();
    if (!dap || get().status !== 'stopped') {
      get().notify({ severity: 'warning', message: 'Run to cursor is only available while paused.' });
      return;
    }
    const temporary: SourceBreakpoint = {
      id: nextId('bp'),
      path,
      line,
      enabled: true,
      verified: false,
      temporary: true,
    };
    updateSourceBreakpoints(path, (list) => [...list, temporary]);
    runToCursorPending = true;
    try {
      await syncSourceFile(path);
      const threadId = currentThreadIdOrNull();
      if (threadId === null) {
        throw new Error('no selected thread');
      }
      set({ status: 'running', statusMessage: 'Running to cursor…' });
      await dap.request('continue', { threadId });
    } catch (error) {
      runToCursorPending = false;
      updateSourceBreakpoints(path, (list) => list.filter((breakpoint) => breakpoint.id !== temporary.id));
      await syncSourceFile(path).catch(() => undefined);
      notifyError('Could not run to cursor', errorText(error));
    }
  }

  async function selectFrame(frameId: number): Promise<void> {
    if (get().selectedFrameId === frameId) {
      return;
    }
    set({ selectedFrameId: frameId });
    await refreshScopes();
    await refreshWatches();
    await refreshInlineValues();
    const frame = selectedFrame();
    const disassemblyTab = get().editorTabs.find((tab) => tab.kind === 'disassembly');
    if (disassemblyTab?.disassembly && frame?.instructionPointerReference) {
      set((state) => ({
        editorTabs: state.editorTabs.map((tab) =>
          tab.id === disassemblyTab.id && tab.disassembly
            ? { ...tab, disassembly: { ...tab.disassembly, pc: frame.instructionPointerReference } }
            : tab,
        ),
      }));
    }
  }

  async function selectThread(threadId: number): Promise<void> {
    set({ currentThreadId: threadId });
    await loadFrames(threadId, false);
  }

  async function loadMoreFrames(): Promise<void> {
    const threadId = get().currentThreadId;
    if (threadId === null) {
      return;
    }
    await loadFrames(threadId, true);
  }

  // --------------------------------------------------------------- variables --

  function collectLocalNames(): Set<string> {
    const names = new Set<string>();
    for (const scope of get().scopes) {
      if (scope.hint === 'registers') {
        continue;
      }
      const page = get().variables[String(scope.variablesReference)];
      for (const node of page?.nodes ?? []) {
        names.add(node.name);
      }
    }
    return names;
  }

  function childExpression(base: string, name: string): string {
    if (!base) {
      return name;
    }
    if (base === '$' || name.startsWith('$')) {
      return name.startsWith('$') ? name : `${base}${name}`;
    }
    if (name.startsWith('[')) {
      return `${base}${name}`;
    }
    return `${base}.${name}`;
  }

  async function fetchVariables(ref: number, append: boolean): Promise<void> {
    const dap = getActiveClient();
    if (!dap) {
      return;
    }
    const key = String(ref);
    const existing = get().variables[key];
    if (existing?.loading) {
      return;
    }
    set((state) => ({
      variables: {
        ...state.variables,
        [key]: {
          nodes: existing?.nodes ?? [],
          start: existing?.start ?? 0,
          hasMore: existing?.hasMore ?? true,
          loading: true,
          error: undefined,
        },
      },
    }));
    try {
      const start = append ? (existing?.start ?? 0) : 0;
      const response = await dap.request<{ variables: Variable[] }>(
        'variables',
        { variablesReference: ref, start, count: PAGE_SIZE },
        20000,
      );
      const baseExpression = refExpressions.get(ref) ?? '';
      const nodes = response.variables.map((variable) => toVariableNode(variable, ref, baseExpression));
      set((state) => ({
        variables: {
          ...state.variables,
          [key]: {
            nodes: append ? [...(state.variables[key]?.nodes ?? []), ...nodes] : nodes,
            start: (append ? (state.variables[key]?.start ?? 0) : 0) + nodes.length,
            hasMore: nodes.length === PAGE_SIZE,
            loading: false,
            error: undefined,
          },
        },
      }));
    } catch (error) {
      set((state) => ({
        variables: {
          ...state.variables,
          [key]: {
            nodes: existing?.nodes ?? [],
            start: existing?.start ?? 0,
            hasMore: false,
            loading: false,
            error: errorText(error),
          },
        },
      }));
    }
  }

  function toVariableNode(variable: Variable, parentRef: number, baseExpression: string): VariableNode {
    return {
      key: `${parentRef}:${variable.name}`,
      name: variable.name,
      value: String(variable.value ?? ''),
      type: variable.type,
      variablesReference: variable.variablesReference ?? 0,
      namedVariables: variable.namedVariables,
      indexedVariables: variable.indexedVariables,
      memoryReference: variable.memoryReference,
      parentRef,
      expression: childExpression(baseExpression, variable.name),
    };
  }

  async function refreshScopes(): Promise<void> {
    const dap = getActiveClient();
    const frameId = get().selectedFrameId;
    if (!dap || frameId === null || get().status !== 'stopped') {
      set({ scopes: [], variables: {}, expandedRefs: {} });
      return;
    }
    try {
      const response = await dap.request<{ scopes: Scope[] }>('scopes', { frameId });
      const scopes: ScopeInfo[] = response.scopes.map((scope) => ({
        name: scope.name,
        hint: scope.presentationHint,
        variablesReference: scope.variablesReference,
        namedVariables: scope.namedVariables,
        indexedVariables: scope.indexedVariables,
        expensive: scope.expensive ?? false,
      }));
      set({ scopes, variables: {}, expandedRefs: {} });
      refExpressions.clear();
      for (const scope of scopes) {
        if (AUTO_EXPANDED_SCOPES.has(scope.hint ?? '')) {
          refExpressions.set(scope.variablesReference, scope.hint === 'registers' ? '$' : '');
          set((state) => ({
            expandedRefs: { ...state.expandedRefs, [String(scope.variablesReference)]: true },
          }));
          await fetchVariables(scope.variablesReference, false);
        }
      }
    } catch (error) {
      appendConsole('error', `could not read variables: ${errorText(error)}`);
      set({ scopes: [], variables: {} });
    }
  }

  async function toggleVariableExpanded(ref: number): Promise<void> {
    const key = String(ref);
    const expanded = get().expandedRefs[key] === true;
    set((state) => {
      const next = { ...state.expandedRefs };
      if (expanded) {
        delete next[key];
      } else {
        next[key] = true;
      }
      return { expandedRefs: next };
    });
    if (!expanded && !get().variables[key]) {
      await fetchVariables(ref, false);
    }
  }

  async function loadMoreVariables(ref: number): Promise<void> {
    const page = get().variables[String(ref)];
    if (!page || !page.hasMore || page.loading) {
      return;
    }
    await fetchVariables(ref, true);
  }

  async function setVariableValue(node: VariableNode, value: string): Promise<void> {
    const dap = getActiveClient();
    if (!dap || get().status !== 'stopped') {
      return;
    }
    try {
      const response = await dap.request<Variable>('setVariable', {
        variablesReference: node.parentRef,
        name: node.name,
        value,
      });
      appendConsole('console', `${node.expression} = ${response.value ?? value}`);
      await fetchVariables(node.parentRef, false);
      await refreshWatches();
    } catch (error) {
      notifyError(`Could not set "${node.expression}"`, errorText(error));
    }
  }

  function addWatchForVariable(node: VariableNode): void {
    void addWatchExpression(node.expression);
  }

  // ------------------------------------------------------------------ watch --

  async function refreshWatches(): Promise<void> {
    const watches = get().watches;
    if (watches.length === 0) {
      return;
    }
    const dap = getActiveClient();
    if (!dap || get().status !== 'stopped') {
      set({
        watches: watches.map((watch) => ({
          ...watch,
          value: undefined,
          type: undefined,
          variablesReference: undefined,
          error: undefined,
          evaluating: false,
        })),
      });
      return;
    }
    set({ watches: watches.map((watch) => ({ ...watch, evaluating: true })) });
    const frameId = get().selectedFrameId ?? undefined;
    const updated = await Promise.all(
      watches.map(async (watch): Promise<WatchItem> => {
        try {
          const response = await dap.request<{ result: string; type?: string; variablesReference: number }>(
            'evaluate',
            { expression: watch.expression, frameId, context: 'watch' },
            15000,
          );
          const variablesReference = response.variablesReference ?? 0;
          if (variablesReference > 0) {
            refExpressions.set(variablesReference, watch.expression);
          }
          return {
            ...watch,
            value: String(response.result),
            type: response.type,
            variablesReference,
            error: undefined,
            evaluating: false,
          };
        } catch (error) {
          return {
            ...watch,
            value: undefined,
            type: undefined,
            variablesReference: undefined,
            error: errorText(error),
            evaluating: false,
          };
        }
      }),
    );
    set({ watches: updated });
  }

  async function addWatchExpression(expression: string): Promise<void> {
    const item: WatchItem = { id: nextId('watch'), expression, evaluating: false };
    set((state) => ({ watches: [...state.watches, item] }));
    await refreshWatches();
  }

  async function addWatch(expression?: string): Promise<void> {
    if (expression !== undefined) {
      await addWatchExpression(expression);
      return;
    }
    get().setQuickInput({
      title: 'Add Watch Expression',
      placeholder: 'Expression to watch',
      value: '',
      onSubmit: async (value) => {
        const expressionValue = value.trim();
        if (!expressionValue) {
          return;
        }
        get().setQuickInput(null);
        await addWatchExpression(expressionValue);
      },
    });
  }

  function removeWatch(id: string): void {
    set((state) => ({ watches: state.watches.filter((watch) => watch.id !== id) }));
  }

  async function editWatch(id: string): Promise<void> {
    const watch = get().watches.find((entry) => entry.id === id);
    if (!watch) {
      return;
    }
    get().setQuickInput({
      title: 'Edit Watch Expression',
      value: watch.expression,
      onSubmit: async (value) => {
        const expressionValue = value.trim();
        if (!expressionValue) {
          return;
        }
        get().setQuickInput(null);
        set((state) => ({
          watches: state.watches.map((entry) =>
            entry.id === id ? { ...entry, expression: expressionValue } : entry,
          ),
        }));
        await refreshWatches();
      },
    });
  }

  // ------------------------------------------------------------- inline/hover --

  const KEYWORDS = new Set([
    'alignas', 'alignof', 'and', 'asm', 'auto', 'bool', 'break', 'case', 'catch', 'char', 'class',
    'const', 'constexpr', 'continue', 'decltype', 'default', 'delete', 'do', 'double', 'else',
    'enum', 'explicit', 'export', 'extern', 'false', 'float', 'for', 'friend', 'goto', 'if',
    'inline', 'int', 'long', 'mutable', 'namespace', 'new', 'noexcept', 'not', 'nullptr',
    'operator', 'or', 'private', 'protected', 'public', 'register', 'return', 'short', 'signed',
    'sizeof', 'static', 'static_cast', 'struct', 'switch', 'template', 'this', 'throw', 'true',
    'try', 'typedef', 'typeid', 'typename', 'union', 'unsigned', 'using', 'virtual', 'void',
    'volatile', 'while', 'std', 'printf', 'size_t', 'NULL', 'and_eq', 'bitand', 'bitor',
    'compl', 'not_eq', 'or_eq', 'xor', 'xor_eq',
  ]);

  function extractExpressions(line: string, names: Set<string>): Array<{ expression: string; start: number; length: number }> {
    // Mask comments and string/character literals, preserving column offsets.
    const masked = line
      .replace(/\/\/.*$/, (match) => ' '.repeat(match.length))
      .replace(/\/\*.*?\*\//g, (match) => ' '.repeat(match.length))
      .replace(/"(?:\\.|[^"\\])*"/g, (match) => ' '.repeat(match.length))
      .replace(/'(?:\\.|[^'\\])*'/g, (match) => ' '.repeat(match.length));
    const pattern = /\b([A-Za-z_]\w*(?:(?:\.|->)[A-Za-z_]\w*|\[[^\]]+\])*)/g;
    const result: Array<{ expression: string; start: number; length: number }> = [];
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(masked)) !== null) {
      const expression = match[1];
      const root = expression.split(/[.\-[>(]/)[0];
      if (KEYWORDS.has(root) || !names.has(root)) {
        continue;
      }
      result.push({ expression, start: match.index, length: expression.length });
      if (result.length >= 12) {
        break;
      }
    }
    return result;
  }

  async function refreshInlineValues(): Promise<void> {
    const state = get();
    if (!state.inlineValuesEnabled || state.status !== 'stopped') {
      if (state.inlineValues.length > 0) {
        set({ inlineValues: [] });
      }
      return;
    }
    const frame = selectedFrame();
    if (!frame?.sourcePath || frame.line <= 0) {
      set({ inlineValues: [] });
      return;
    }
    const text = await getFileText(frame.sourcePath);
    if (text === null) {
      set({ inlineValues: [] });
      return;
    }
    const lineText = text.split('\n')[frame.line - 1] ?? '';
    const names = collectLocalNames();
    if (!lineText || names.size === 0) {
      set({ inlineValues: [] });
      return;
    }
    const matches = extractExpressions(lineText, names);
    if (matches.length === 0) {
      set({ inlineValues: [] });
      return;
    }
    const dap = getActiveClient();
    if (!dap) {
      return;
    }
    const values = await Promise.all(
      matches.map(async (match): Promise<InlineValue | null> => {
        try {
          const response = await dap.request<{ result: string; type?: string }>(
            'evaluate',
            { expression: match.expression, frameId: frame.id, context: 'hover' },
            5000,
          );
          return {
            name: match.expression,
            value: String(response.result),
            type: response.type,
            line: frame.line,
            startColumn: match.start + 1,
            endColumn: match.start + match.length + 1,
          };
        } catch {
          return null;
        }
      }),
    );
    if (get().selectedFrameId !== frame.id || get().status !== 'stopped') {
      return;
    }
    set({ inlineValues: values.filter((value): value is InlineValue => value !== null) });
  }

  async function evaluateForHover(
    expression: string,
    frameId: number,
  ): Promise<{ value: string; type?: string } | null> {
    const dap = getActiveClient();
    if (!dap || get().status !== 'stopped') {
      return null;
    }
    try {
      const response = await dap.request<{ result: string; type?: string }>(
        'evaluate',
        { expression, frameId, context: 'hover' },
        5000,
      );
      return { value: String(response.result), type: response.type };
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- console --

  async function executeConsoleCommand(text: string): Promise<void> {
    const command = text.trim();
    if (!command) {
      return;
    }
    appendConsole('input', command);
    const dap = getActiveClient();
    const status = get().status;
    if (!dap || status === 'inactive' || status === 'error') {
      appendConsole('error', 'No active debug session.');
      return;
    }
    if (status === 'running' || status === 'initializing') {
      appendConsole('error', 'The program is running. Pause it before evaluating expressions.');
      return;
    }
    const frameId = get().selectedFrameId ?? undefined;
    try {
      const response = await dap.request<{
        result: string;
        variablesReference: number;
      }>('evaluate', { expression: command, frameId, context: 'variables' }, 15000);
      if (response.variablesReference > 0) {
        refExpressions.set(response.variablesReference, command);
      }
      appendConsole('result', String(response.result));
      return;
    } catch {
      // gdb evaluates expressions and commands through different contexts;
      // fall through to the command interpreter like cpptools does.
    }
    try {
      const response = await dap.request<{ result: string }>(
        'evaluate',
        { expression: command, frameId, context: 'repl' },
        15000,
      );
      const output = String(response.result ?? '');
      appendConsole('result', output.length > 0 ? output : '(no output)');
    } catch (error) {
      appendConsole('error', errorText(error));
    }
  }

  function clearConsole(): void {
    set({ consoleLines: [] });
  }

  function clearOutput(): void {
    set({ outputLines: [] });
  }

  function sendTerminalInput(data: Uint8Array): void {
    const dap = getActiveClient();
    if (!dap || !get().terminal.available) {
      return;
    }
    dap.control('terminalInput', { data: bytesToBase64(data) });
  }

  function resizeTerminal(cols: number, rows: number): void {
    const dap = getActiveClient();
    if (!dap || !get().terminal.available) {
      return;
    }
    dap.control('terminalResize', { cols, rows });
  }

  function clearTerminal(): void {
    resetTerminalPending();
    set((state) => ({
      terminal: { ...state.terminal, chunks: [], epoch: state.terminal.epoch + 1 },
    }));
  }

  // --------------------------------------------------------------- memory --

  function base64ToHex(base64: string): string {
    const binary = atob(base64);
    let hex = '';
    for (let index = 0; index < binary.length; index++) {
      hex += binary.charCodeAt(index).toString(16).padStart(2, '0');
    }
    return hex;
  }

  function updateMemoryTab(tabId: string, patch: Partial<NonNullable<EditorTab['memory']>>): void {
    set((state) => ({
      editorTabs: state.editorTabs.map((tab) =>
        tab.id === tabId && tab.memory
          ? { ...tab, memory: { ...tab.memory, ...patch } }
          : tab,
      ),
    }));
  }

  async function reloadMemory(tabId: string, address?: string): Promise<void> {
    const tab = get().editorTabs.find((entry) => entry.id === tabId);
    if (!tab?.memory) {
      return;
    }
    const target = address ?? tab.memory.address;
    if (!target) {
      updateMemoryTab(tabId, { error: 'Enter a memory address first.' });
      return;
    }
    const dap = getActiveClient();
    if (!dap) {
      updateMemoryTab(tabId, { error: 'No active debug session.' });
      return;
    }
    updateMemoryTab(tabId, { loading: true, error: undefined, address: target });
    try {
      const response = await dap.request<{ address: string; data: string }>(
        'readMemory',
        { memoryReference: target, count: MEMORY_PAGE_BYTES },
        10000,
      );
      updateMemoryTab(tabId, {
        address: response.address ?? target,
        bytes: base64ToHex(response.data ?? ''),
        loading: false,
        error: undefined,
      });
    } catch (error) {
      updateMemoryTab(tabId, { loading: false, error: errorText(error) });
    }
  }

  async function setMemoryAddress(tabId: string, expression: string): Promise<void> {
    const value = expression.trim();
    if (!value) {
      return;
    }
    if (/^0x[0-9a-fA-F]+$/.test(value) || /^[0-9]+$/.test(value)) {
      await reloadMemory(tabId, value);
      return;
    }
    const dap = getActiveClient();
    if (!dap || get().status !== 'stopped') {
      updateMemoryTab(tabId, { error: 'Pause the program before evaluating an address expression.' });
      return;
    }
    try {
      const response = await dap.request<{ result: string }>(
        'evaluate',
        {
          expression: `(void*)(${value})`,
          frameId: get().selectedFrameId ?? undefined,
          context: 'variables',
        },
        10000,
      );
      const address = extractAddress(String(response.result));
      if (!address) {
        throw new Error(`"${value}" did not evaluate to an address (${response.result})`);
      }
      await reloadMemory(tabId, address);
    } catch (error) {
      updateMemoryTab(tabId, { error: errorText(error) });
    }
  }

  // ----------------------------------------------------------- disassembly --

  async function resolveFunctionStart(frame: StackFrameInfo): Promise<string | null> {
    const dap = getActiveClient();
    if (!dap) {
      return null;
    }
    try {
      const symbol = frame.name.replace(/'/g, "\\'");
      const response = await dap.request<{ result: string }>(
        'evaluate',
        { expression: `(void*)'${symbol}'`, frameId: frame.id, context: 'variables' },
        5000,
      );
      return extractAddress(String(response.result));
    } catch {
      return null;
    }
  }

  function instructionFromDap(instruction: DisassembledInstruction): InstructionInfo {
    return {
      address: instruction.address,
      instruction: instruction.instruction,
      instructionBytes: instruction.instructionBytes,
      symbol: instruction.symbol,
      sourcePath: mapSourcePath(instruction.location?.path),
      sourceName: instruction.location?.name,
      line: instruction.line,
    };
  }

  function nextAddressOf(instructions: InstructionInfo[]): string | undefined {
    const last = instructions[instructions.length - 1];
    if (!last) {
      return undefined;
    }
    const bytes = last.instructionBytes ? Math.max(1, Math.floor(last.instructionBytes.length / 2)) : 4;
    try {
      return '0x' + (BigInt(last.address) + BigInt(bytes)).toString(16);
    } catch {
      return undefined;
    }
  }

  function updateDisassemblyTab(tabId: string, patch: Partial<NonNullable<EditorTab['disassembly']>>): void {
    set((state) => ({
      editorTabs: state.editorTabs.map((tab) =>
        tab.id === tabId && tab.disassembly
          ? { ...tab, disassembly: { ...tab.disassembly, ...patch } }
          : tab,
      ),
    }));
  }

  async function loadDisassembly(tabId: string, explicitAddress?: string): Promise<void> {
    const tab = get().editorTabs.find((entry) => entry.id === tabId);
    if (!tab?.disassembly) {
      return;
    }
    const dap = getActiveClient();
    if (!dap || get().status !== 'stopped') {
      updateDisassemblyTab(tabId, {
        loading: false,
        error: 'The disassembly view is available while the program is paused.',
      });
      return;
    }
    updateDisassemblyTab(tabId, { loading: true, error: undefined });
    const frame = selectedFrame();
    let base = explicitAddress;
    if (!base && frame) {
      base = (await resolveFunctionStart(frame)) ?? frame.instructionPointerReference;
    }
    if (!base) {
      updateDisassemblyTab(tabId, {
        loading: false,
        error: 'No instruction address is available. Select a stack frame first.',
      });
      return;
    }
    try {
      const response = await dap.request<{ instructions: DisassembledInstruction[] }>(
        'disassemble',
        { memoryReference: base, offset: 0, instructionOffset: 0, instructionCount: DISASSEMBLY_PAGE },
        20000,
      );
      const instructions = response.instructions.map(instructionFromDap);
      updateDisassemblyTab(tabId, {
        base,
        pc: frame?.instructionPointerReference,
        instructions,
        nextAddress: nextAddressOf(instructions),
        hasMore: instructions.length === DISASSEMBLY_PAGE,
        loading: false,
        error: undefined,
      });
    } catch (error) {
      updateDisassemblyTab(tabId, { loading: false, error: errorText(error) });
    }
  }

  async function loadMoreDisassembly(tabId: string): Promise<void> {
    const tab = get().editorTabs.find((entry) => entry.id === tabId);
    const dap = getActiveClient();
    if (!tab?.disassembly?.nextAddress || !dap) {
      return;
    }
    updateDisassemblyTab(tabId, { loading: true });
    try {
      const response = await dap.request<{ instructions: DisassembledInstruction[] }>(
        'disassemble',
        {
          memoryReference: tab.disassembly.nextAddress,
          offset: 0,
          instructionOffset: 0,
          instructionCount: DISASSEMBLY_PAGE,
        },
        20000,
      );
      set((state) => ({
        editorTabs: state.editorTabs.map((entry) => {
          if (entry.id !== tabId || !entry.disassembly) {
            return entry;
          }
          const existingAddresses = new Set(entry.disassembly.instructions.map((instruction) => instruction.address));
          const appended = response.instructions
            .map(instructionFromDap)
            .filter((instruction) => !existingAddresses.has(instruction.address));
          const instructions = [...entry.disassembly.instructions, ...appended];
          return {
            ...entry,
            disassembly: {
              ...entry.disassembly,
              instructions,
              nextAddress: nextAddressOf(appended),
              hasMore: response.instructions.length === DISASSEMBLY_PAGE,
              loading: false,
            },
          };
        }),
      }));
    } catch (error) {
      updateDisassemblyTab(tabId, { loading: false, error: errorText(error) });
    }
  }

  function setDisassemblyFollow(tabId: string, follow: boolean): void {
    updateDisassemblyTab(tabId, { follow });
  }

  // ------------------------------------------------------------- open views --

  async function openDisassemblyView(options?: { address?: string }): Promise<void> {
    let tab = get().editorTabs.find((entry) => entry.kind === 'disassembly');
    if (!tab) {
      tab = {
        id: nextId('disassembly'),
        kind: 'disassembly',
        title: 'Disassembly',
        pinned: true,
        dirty: false,
        disassembly: {
          instructions: [],
          hasMore: false,
          loading: true,
          follow: true,
        },
      };
      set((state) => ({ editorTabs: [...state.editorTabs, tab as EditorTab], activeTabId: tab!.id }));
    } else {
      set({ activeTabId: tab.id });
    }
    await loadDisassembly(tab.id, options?.address);
  }

  async function openMemoryView(options?: { address?: string; label?: string }): Promise<void> {
    let tab = get().editorTabs.find((entry) => entry.kind === 'memory');
    if (!tab) {
      tab = {
        id: nextId('memory'),
        kind: 'memory',
        title: 'Memory',
        pinned: true,
        dirty: false,
        memory: {
          address: options?.address ?? '',
          bytes: '',
          loading: false,
          label: options?.label,
        },
      };
      set((state) => ({ editorTabs: [...state.editorTabs, tab as EditorTab], activeTabId: tab!.id }));
    } else {
      set({ activeTabId: tab.id });
      if (options?.address) {
        set((state) => ({
          editorTabs: state.editorTabs.map((entry) =>
            entry.id === tab!.id && entry.memory
              ? { ...entry, memory: { ...entry.memory, address: options.address as string, label: options.label ?? entry.memory.label } }
              : entry,
          ),
        }));
      }
    }
    if (options?.address) {
      await reloadMemory(tab.id, options.address);
      return;
    }
    const dap = getActiveClient();
    let address: string | null = null;
    if (dap && get().status === 'stopped') {
      for (const expression of ['$sp', '$rsp', '$r1']) {
        try {
          const response = await dap.request<{ result: string }>(
            'evaluate',
            { expression, frameId: get().selectedFrameId ?? undefined, context: 'variables' },
            5000,
          );
          address = extractAddress(String(response.result));
          if (address) {
            break;
          }
        } catch {
          // Try the next stack pointer spelling.
        }
      }
    }
    if (!address) {
      updateMemoryTab(tab.id, {
        loading: false,
        error: 'No address to show. Enter a hex address or pause with a stack frame selected.',
      });
      return;
    }
    await reloadMemory(tab.id, address);
  }

  async function openProcessPicker(configName?: string): Promise<void> {
    let processes;
    try {
      processes = (await api.processes()).processes;
    } catch (error) {
      notifyError('Could not list processes', errorText(error));
      return;
    }
    if (processes.length === 0) {
      notifyError('No attachable processes found');
      return;
    }
    get().setQuickInput({
      title: configName ? `Attach to Process (${configName})` : 'Attach to Process',
      placeholder: 'Filter processes by name or pid',
      value: '',
      items: processes.map((processInfo) => ({
        label: `${processInfo.name} (${processInfo.pid})`,
        description: String(processInfo.pid),
        detail: processInfo.cmdline,
        action: () => {
          get().setQuickInput(null);
          void startDebugging(configName, { pid: processInfo.pid });
        },
      })),
      onSubmit: (value) => {
        const filter = value.trim().toLowerCase();
        const match = processes.find(
          (processInfo) =>
            String(processInfo.pid) === filter || processInfo.name.toLowerCase() === filter,
        );
        if (match) {
          get().setQuickInput(null);
          void startDebugging(configName, { pid: match.pid });
        }
      },
    });
  }

  async function showDapTrace(): Promise<void> {
    const dap = getActiveClient();
    if (!dap) {
      get().notify({ severity: 'info', message: 'Start a debug session to inspect the DAP trace.' });
      return;
    }
    try {
      const entries = (await dap.requestTrace()) as Array<{
        time: string;
        direction: string;
        message: unknown;
      }>;
      const lines = entries.map((entry) => {
        const body = typeof entry.message === 'string' ? entry.message.trim() : JSON.stringify(entry.message);
        return `${entry.time} [${entry.direction}] ${body}`;
      });
      set((state) => ({
        panelVisible: true,
        panelTab: 'output',
        outputLines: [
          ...state.outputLines,
          { id: nextId('out'), kind: 'console' as const, text: '', time: Date.now() },
          ...lines.map((text) => ({ id: nextId('out'), kind: 'console' as const, text, time: Date.now() })),
        ].slice(-MAX_OUTPUT_LINES),
      }));
    } catch (error) {
      notifyError('Could not read the DAP trace', errorText(error));
    }
  }

  return {
    // session
    startDebugging,
    stopDebugging,
    restartDebugging,
    continueExecution,
    pauseExecution,
    stepOver,
    stepInto,
    stepOut,
    runToCursor,
    selectFrame,
    selectThread,
    loadMoreFrames,
    // breakpoints
    toggleBreakpoint: async (path: string, line: number) => {
      const existing = (get().breakpoints[path] ?? []).find(
        (breakpoint) => breakpoint.line === line && !breakpoint.temporary,
      );
      if (existing) {
        updateSourceBreakpoints(path, (list) => list.filter((breakpoint) => breakpoint.id !== existing.id));
      } else {
        updateSourceBreakpoints(path, (list) => [
          ...list,
          { id: nextId('bp'), path, line, enabled: true, verified: false },
        ]);
      }
      await syncSourceFile(path).catch((error) => reportSyncFailure(error, path));
    },
    addConditionalBreakpoint: async (path: string, line: number) => {
      const existing = (get().breakpoints[path] ?? []).find(
        (breakpoint) => breakpoint.line === line && !breakpoint.temporary,
      );
      get().setQuickInput({
        title: `Add Conditional Breakpoint (${path.split('/').pop()}:${line})`,
        placeholder: 'Expression that must evaluate to true',
        value: existing?.condition ?? '',
        onSubmit: async (value) => {
          const condition = trimmedOrUndefined(value);
          if (!condition) {
            return;
          }
          get().setQuickInput(null);
          if (existing) {
            updateSourceBreakpoints(path, (list) =>
              list.map((breakpoint) =>
                breakpoint.id === existing.id
                  ? { ...breakpoint, condition, logMessage: undefined, enabled: true }
                  : breakpoint,
              ),
            );
          } else {
            updateSourceBreakpoints(path, (list) => [
              ...list,
              { id: nextId('bp'), path, line, enabled: true, verified: false, condition },
            ]);
          }
          await syncSourceFile(path).catch((error) => reportSyncFailure(error, path));
        },
      });
    },
    addLogpoint: async (path: string, line: number) => {
      const existing = (get().breakpoints[path] ?? []).find(
        (breakpoint) => breakpoint.line === line && !breakpoint.temporary,
      );
      get().setQuickInput({
        title: `Add Logpoint (${path.split('/').pop()}:${line})`,
        placeholder: 'Message; use {expression} to interpolate',
        value: existing?.logMessage ?? '',
        onSubmit: async (value) => {
          const logMessage = trimmedOrUndefined(value);
          if (!logMessage) {
            return;
          }
          get().setQuickInput(null);
          if (existing) {
            updateSourceBreakpoints(path, (list) =>
              list.map((breakpoint) =>
                breakpoint.id === existing.id
                  ? { ...breakpoint, logMessage, enabled: true }
                  : breakpoint,
              ),
            );
          } else {
            updateSourceBreakpoints(path, (list) => [
              ...list,
              { id: nextId('bp'), path, line, enabled: true, verified: false, logMessage },
            ]);
          }
          await syncSourceFile(path).catch((error) => reportSyncFailure(error, path));
        },
      });
    },
    editBreakpointCondition: async (id: string) => {
      const found = findSourceBreakpoint(id);
      if (!found) {
        return;
      }
      get().setQuickInput({
        title: `Edit Condition (${found.path.split('/').pop()}:${found.breakpoint.line})`,
        placeholder: 'Condition expression (empty removes the condition)',
        value: found.breakpoint.condition ?? '',
        onSubmit: async (value) => {
          get().setQuickInput(null);
          updateSourceBreakpoints(found.path, (list) =>
            list.map((breakpoint) =>
              breakpoint.id === id ? { ...breakpoint, condition: trimmedOrUndefined(value) } : breakpoint,
            ),
          );
          await syncSourceFile(found.path).catch((error) => reportSyncFailure(error, found.path));
        },
      });
    },
    editBreakpointHitCount: async (id: string) => {
      const found = findSourceBreakpoint(id);
      if (!found) {
        return;
      }
      get().setQuickInput({
        title: `Edit Hit Count (${found.path.split('/').pop()}:${found.breakpoint.line})`,
        placeholder: 'Number of hits gdb should ignore before stopping',
        value: found.breakpoint.hitCondition ?? '',
        onSubmit: async (value) => {
          get().setQuickInput(null);
          updateSourceBreakpoints(found.path, (list) =>
            list.map((breakpoint) =>
              breakpoint.id === id ? { ...breakpoint, hitCondition: trimmedOrUndefined(value) } : breakpoint,
            ),
          );
          await syncSourceFile(found.path).catch((error) => reportSyncFailure(error, found.path));
        },
      });
    },
    editBreakpointLogMessage: async (id: string) => {
      const found = findSourceBreakpoint(id);
      if (!found) {
        return;
      }
      get().setQuickInput({
        title: `Edit Log Message (${found.path.split('/').pop()}:${found.breakpoint.line})`,
        placeholder: 'Message; use {expression} to interpolate (empty makes it a breakpoint)',
        value: found.breakpoint.logMessage ?? '',
        onSubmit: async (value) => {
          get().setQuickInput(null);
          updateSourceBreakpoints(found.path, (list) =>
            list.map((breakpoint) =>
              breakpoint.id === id ? { ...breakpoint, logMessage: trimmedOrUndefined(value) } : breakpoint,
            ),
          );
          await syncSourceFile(found.path).catch((error) => reportSyncFailure(error, found.path));
        },
      });
    },
    removeBreakpoint: async (id: string) => {
      const found = findSourceBreakpoint(id);
      if (!found) {
        return;
      }
      updateSourceBreakpoints(found.path, (list) => list.filter((breakpoint) => breakpoint.id !== id));
      await syncSourceFile(found.path).catch((error) => reportSyncFailure(error, found.path));
    },
    setBreakpointEnabled: async (id: string, enabled: boolean) => {
      const found = findSourceBreakpoint(id);
      if (!found) {
        return;
      }
      updateSourceBreakpoints(found.path, (list) =>
        list.map((breakpoint) => (breakpoint.id === id ? { ...breakpoint, enabled } : breakpoint)),
      );
      await syncSourceFile(found.path).catch((error) => reportSyncFailure(error, found.path));
    },
    setAllBreakpointsEnabled: async (enabled: boolean) => {
      const paths = Object.keys(get().breakpoints);
      set((state) => ({
        breakpoints: Object.fromEntries(
          Object.entries(state.breakpoints).map(([path, list]) => [
            path,
            list.map((breakpoint) => ({ ...breakpoint, enabled })),
          ]),
        ),
        functionBreakpoints: state.functionBreakpoints.map((breakpoint) => ({ ...breakpoint, enabled })),
        instructionBreakpoints: state.instructionBreakpoints.map((breakpoint) => ({ ...breakpoint, enabled })),
      }));
      for (const path of paths) {
        await syncSourceFile(path).catch((error) => reportSyncFailure(error, path));
      }
      await syncFunctionBreakpoints().catch((error) => reportSyncFailure(error, 'function breakpoints'));
      await syncInstructionBreakpoints().catch((error) => reportSyncFailure(error, 'instruction breakpoints'));
    },
    removeAllBreakpoints: async () => {
      const paths = Object.keys(get().breakpoints);
      set({ breakpoints: {}, functionBreakpoints: [], instructionBreakpoints: [] });
      for (const path of paths) {
        await syncSourceFile(path).catch((error) => reportSyncFailure(error, path));
      }
      await syncFunctionBreakpoints().catch((error) => reportSyncFailure(error, 'function breakpoints'));
      await syncInstructionBreakpoints().catch((error) => reportSyncFailure(error, 'instruction breakpoints'));
    },
    addFunctionBreakpoint: async () => {
      get().setQuickInput({
        title: 'Add Function Breakpoint',
        placeholder: 'Function name, e.g. factorial',
        value: '',
        onSubmit: async (value) => {
          const name = value.trim();
          if (!name) {
            return;
          }
          get().setQuickInput(null);
          updateFunctionBreakpoints((list) => [
            ...list,
            { id: nextId('fn'), name, enabled: true, verified: false },
          ]);
          await syncFunctionBreakpoints().catch((error) => reportSyncFailure(error, 'function breakpoints'));
        },
      });
    },
    editFunctionBreakpointCondition: async (id: string) => {
      const breakpoint = get().functionBreakpoints.find((entry) => entry.id === id);
      if (!breakpoint) {
        return;
      }
      get().setQuickInput({
        title: `Edit Function Condition (${breakpoint.name})`,
        placeholder: 'Condition expression (empty removes it)',
        value: breakpoint.condition ?? '',
        onSubmit: async (value) => {
          get().setQuickInput(null);
          updateFunctionBreakpoints((list) =>
            list.map((entry) =>
              entry.id === id ? { ...entry, condition: trimmedOrUndefined(value) } : entry,
            ),
          );
          await syncFunctionBreakpoints().catch((error) => reportSyncFailure(error, 'function breakpoints'));
        },
      });
    },
    editFunctionBreakpointHitCount: async (id: string) => {
      const breakpoint = get().functionBreakpoints.find((entry) => entry.id === id);
      if (!breakpoint) {
        return;
      }
      get().setQuickInput({
        title: `Edit Function Hit Count (${breakpoint.name})`,
        placeholder: 'Hits gdb should ignore before stopping',
        value: breakpoint.hitCondition ?? '',
        onSubmit: async (value) => {
          get().setQuickInput(null);
          updateFunctionBreakpoints((list) =>
            list.map((entry) =>
              entry.id === id ? { ...entry, hitCondition: trimmedOrUndefined(value) } : entry,
            ),
          );
          await syncFunctionBreakpoints().catch((error) => reportSyncFailure(error, 'function breakpoints'));
        },
      });
    },
    removeFunctionBreakpoint: async (id: string) => {
      updateFunctionBreakpoints((list) => list.filter((breakpoint) => breakpoint.id !== id));
      await syncFunctionBreakpoints().catch((error) => reportSyncFailure(error, 'function breakpoints'));
    },
    setFunctionBreakpointEnabled: async (id: string, enabled: boolean) => {
      updateFunctionBreakpoints((list) =>
        list.map((breakpoint) => (breakpoint.id === id ? { ...breakpoint, enabled } : breakpoint)),
      );
      await syncFunctionBreakpoints().catch((error) => reportSyncFailure(error, 'function breakpoints'));
    },
    addInstructionBreakpoint: async (address: string) => {
      if (get().instructionBreakpoints.some((breakpoint) => breakpoint.instructionReference === address)) {
        return;
      }
      updateInstructionBreakpoints((list) => [
        ...list,
        { id: nextId('insn'), instructionReference: address, enabled: true, verified: false },
      ]);
      await syncInstructionBreakpoints().catch((error) => reportSyncFailure(error, 'instruction breakpoints'));
    },
    toggleInstructionBreakpoint: async (address: string) => {
      const existing = get().instructionBreakpoints.find(
        (breakpoint) => breakpoint.instructionReference === address,
      );
      if (existing) {
        updateInstructionBreakpoints((list) => list.filter((breakpoint) => breakpoint.id !== existing.id));
      } else {
        updateInstructionBreakpoints((list) => [
          ...list,
          { id: nextId('insn'), instructionReference: address, enabled: true, verified: false },
        ]);
      }
      await syncInstructionBreakpoints().catch((error) => reportSyncFailure(error, 'instruction breakpoints'));
    },
    removeInstructionBreakpoint: async (id: string) => {
      updateInstructionBreakpoints((list) => list.filter((breakpoint) => breakpoint.id !== id));
      await syncInstructionBreakpoints().catch((error) => reportSyncFailure(error, 'instruction breakpoints'));
    },
    removeAllInstructionBreakpoints: async () => {
      set({ instructionBreakpoints: [] });
      await syncInstructionBreakpoints().catch((error) => reportSyncFailure(error, 'instruction breakpoints'));
    },
    addDataBreakpoint,
    promptAddDataBreakpoint,
    removeDataBreakpoint,
    setDataBreakpointEnabled,
    removeAllDataBreakpoints,
    setExceptionFilter: async (filter: string, enabled: boolean) => {
      set((state) => ({
        exceptionFilters: state.exceptionFilters.map((entry) =>
          entry.filter === filter ? { ...entry, enabled } : entry,
        ),
      }));
      await syncExceptionBreakpoints().catch((error) => reportSyncFailure(error, 'exception breakpoints'));
    },
    editExceptionCondition: async (filter: string) => {
      const entry = get().exceptionFilters.find((candidate) => candidate.filter === filter);
      if (!entry) {
        return;
      }
      get().setQuickInput({
        title: `Edit Exception Condition (${entry.label})`,
        placeholder: 'Condition expression (empty removes it)',
        value: entry.condition ?? '',
        onSubmit: async (value) => {
          get().setQuickInput(null);
          set((state) => ({
            exceptionFilters: state.exceptionFilters.map((candidate) =>
              candidate.filter === filter
                ? { ...candidate, condition: trimmedOrUndefined(value) }
                : candidate,
            ),
          }));
          await syncExceptionBreakpoints().catch((error) => reportSyncFailure(error, 'exception breakpoints'));
        },
      });
    },
    // variables
    refreshScopes,
    toggleVariableExpanded,
    loadMoreVariables,
    setVariableValue,
    addWatchForVariable,
    addWatch,
    removeWatch,
    editWatch,
    executeConsoleCommand,
    clearConsole,
    clearOutput,
    sendTerminalInput,
    resizeTerminal,
    clearTerminal,
    evaluateForHover,
    refreshInlineValues,
    openProcessPicker,
    showDapTrace,
    // views
    openDisassemblyView,
    openMemoryView,
    reloadMemory,
    setMemoryAddress,
    reloadDisassembly: (tabId: string) => loadDisassembly(tabId),
    loadMoreDisassembly,
    setDisassemblyFollow,
  };
}

export type DebugController = ReturnType<typeof createDebugController>;
