/**
 * Types shared by the Node backend and the browser front end.
 *
 * Keep this module free of runtime code and of Node-only imports: it is
 * compiled into both bundles.
 */

export interface FileEntry {
  name: string;
  /** Workspace-relative path. */
  path: string;
  type: 'file' | 'directory';
  size: number;
}

export interface FileContent {
  path: string;
  content: string;
  language: string;
  size: number;
  mtimeMs: number;
  binary: boolean;
}

export interface SetupCommand {
  text: string;
  description?: string;
  ignoreFailures?: boolean;
}

export type LaunchRequestKind = 'launch' | 'attach';

/** Where the inferior's stdio lives. VS Code calls this "console". */
export type StartupConsole = 'internalConsole' | 'integratedTerminal';

export interface NormalizedLaunchConfig {
  index: number;
  name: string;
  type: string;
  request: LaunchRequestKind;
  program?: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  stopAtBeginningOfMainSubprogram: boolean;
  stopOnEntry: boolean;
  console: StartupConsole;
  miDebuggerPath: string;
  miDebuggerArgs: string[];
  setupCommands: SetupCommand[];
  sourceFileMap: Record<string, string>;
  target?: string;
  pid?: number;
  /** The configuration asked the IDE to pick a process (${command:pickProcess}). */
  pickProcess: boolean;
  warnings: string[];
}

export interface LaunchFileResult {
  exists: boolean;
  /** Absolute path to .vscode/launch.json. */
  path: string;
  relativePath: string;
  configs: NormalizedLaunchConfig[];
  errors: string[];
}

export interface ProcessInfo {
  pid: number;
  name: string;
  cmdline: string;
  exe: string | null;
}

export interface EnvironmentInfo {
  gdbPath: string;
  version: string | null;
  available: boolean;
  error?: string;
  platform: string;
  arch: string;
  node: string;
}

export interface WorkspaceInfo {
  root: string;
  name: string;
}

/** Transport-level request that spawns gdb for one WebSocket connection. */
export interface StartSessionRequest {
  gdbPath?: string;
  gdbArgs?: string[];
  program?: string;
  cwd?: string;
  /** Allocate a pty and expose it for `set inferior-tty`. */
  terminal?: TerminalOptions;
}

export interface TerminalOptions {
  cols?: number;
  rows?: number;
}

export type ControlEvent =
  | 'started'
  | 'error'
  | 'gdbStderr'
  | 'gdbExited'
  | 'trace'
  | 'terminalData'
  | 'terminalExit'
  | 'terminalError';

export interface ControlMessage {
  type: 'control';
  event: ControlEvent;
  body?: any;
}

export interface TraceEntry {
  time: string;
  direction: 'client' | 'adapter' | 'stderr';
  message: unknown;
}
