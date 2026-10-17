import type { Capabilities, Thread, StackFrame, Scope, Variable, DisassembledInstruction } from '../dap/protocol.ts';
import type {
  FileEntry,
  NormalizedLaunchConfig,
  StartupConsole,
} from '../../shared/types.ts';
import type { WatchpointAccess } from '../../shared/watchpoints.ts';

export type SessionStatus =
  | 'inactive'
  | 'initializing'
  | 'running'
  | 'stopped'
  | 'terminated'
  | 'error';

export type StopKind =
  | 'breakpoint'
  | 'step'
  | 'exception'
  | 'pause'
  | 'entry'
  | 'signal'
  | 'data breakpoint'
  | 'other';

export interface SourceBreakpoint {
  id: string;
  path: string;
  line: number;
  enabled: boolean;
  verified: boolean;
  message?: string;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
  adapterId?: number;
  instructionReference?: string;
  temporary?: boolean;
}

export interface FunctionBreakpoint {
  id: string;
  name: string;
  enabled: boolean;
  verified: boolean;
  message?: string;
  condition?: string;
  hitCondition?: string;
  adapterId?: number;
}

export interface InstructionBreakpoint {
  id: string;
  instructionReference: string;
  offset?: number;
  enabled: boolean;
  verified: boolean;
  message?: string;
  condition?: string;
  hitCondition?: string;
  adapterId?: number;
  sourcePath?: string;
  line?: number;
}

export interface DataBreakpoint {
  id: string;
  expression: string;
  access: WatchpointAccess;
  enabled: boolean;
  verified: boolean;
  /** gdb's watchpoint number, used for `delete` and stop-event mapping. */
  adapterId?: number;
  message?: string;
  sourcePath?: string;
  line?: number;
}

export interface ExceptionFilterState {
  filter: string;
  label: string;
  enabled: boolean;
  supportsCondition: boolean;
  condition?: string;
  adapterId?: number;
}

export interface ThreadInfo {
  id: number;
  name: string;
}

export interface StackFrameInfo {
  id: number;
  name: string;
  line: number;
  column: number;
  /** Adapter path after sourceFileMap remapping. */
  sourcePath?: string;
  sourceName?: string;
  instructionPointerReference?: string;
  moduleId?: string | number;
}

export interface ScopeInfo {
  name: string;
  hint?: string;
  variablesReference: number;
  namedVariables?: number;
  indexedVariables?: number;
  expensive: boolean;
}

export interface VariableNode {
  key: string;
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
  namedVariables?: number;
  indexedVariables?: number;
  memoryReference?: string;
  parentRef: number;
  /** Expression that identifies this value, used by "Add to Watch". */
  expression: string;
}

export interface VariablesPage {
  nodes: VariableNode[];
  start: number;
  hasMore: boolean;
  loading: boolean;
  error?: string;
}

export interface WatchItem {
  id: string;
  expression: string;
  value?: string;
  type?: string;
  error?: string;
  variablesReference?: number;
  evaluating: boolean;
}

export interface InlineValue {
  name: string;
  value: string;
  type?: string;
  line: number;
  startColumn: number;
  endColumn: number;
}

export type ConsoleLineKind = 'input' | 'stdout' | 'stderr' | 'console' | 'info' | 'error' | 'result';

export interface ConsoleLine {
  id: string;
  kind: ConsoleLineKind;
  text: string;
  time: number;
}

export interface NotificationAction {
  label: string;
  action: () => void;
}

export interface Notification {
  id: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  detail?: string;
  actions?: NotificationAction[];
}

export interface ContextMenuItem {
  label?: string;
  keybinding?: string;
  disabled?: boolean;
  separator?: boolean;
  action?: () => void;
}

export interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

export interface QuickPickItem {
  label: string;
  description?: string;
  detail?: string;
  icon?: string;
  action: () => void;
}

export interface QuickInputState {
  title: string;
  prompt?: string;
  value: string;
  placeholder?: string;
  items?: QuickPickItem[];
  onSubmit: (value: string) => void | Promise<void>;
  validate?: (value: string) => string | undefined;
}

export interface InstructionInfo {
  address: string;
  instruction: string;
  instructionBytes?: string;
  symbol?: string;
  sourcePath?: string;
  sourceName?: string;
  line?: number;
}

export interface DisassemblyState {
  base?: string;
  pc?: string;
  instructions: InstructionInfo[];
  nextAddress?: string;
  hasMore: boolean;
  loading: boolean;
  error?: string;
  title?: string;
  follow: boolean;
}

export interface MemoryState {
  address: string;
  bytes: string;
  loading: boolean;
  error?: string;
  label?: string;
}

export type EditorTabKind = 'source' | 'disassembly' | 'memory' | 'launch' | 'welcome';

export interface EditorTab {
  id: string;
  kind: EditorTabKind;
  title: string;
  /** Absolute path for source and launch tabs. */
  path?: string;
  pinned: boolean;
  dirty: boolean;
  launchContent?: string;
  launchSavedContent?: string;
  disassembly?: DisassemblyState;
  memory?: MemoryState;
}

export interface TerminalState {
  /** A pty was allocated for the current (or last) session. */
  available: boolean;
  slavePath: string | null;
  /** base64-encoded output chunks, written to xterm in order. */
  chunks: string[];
  /** Increments when the chunk buffer is truncated; xterm resets on change. */
  epoch: number;
  exited: boolean;
  error: string | null;
  /** Console mode of the active configuration. */
  console: StartupConsole | null;
}

export interface ConfigSelection {
  config: NormalizedLaunchConfig;
  pid?: number;
}

export interface RevealRequest {
  path: string;
  line: number;
  column?: number;
  token: number;
}

export interface DebugState {
  bootstrapped: boolean;
  workspace: { root: string; name: string } | null;
  environment: { gdbPath: string; version: string | null; available: boolean } | null;

  // Session
  status: SessionStatus;
  activeConfig: NormalizedLaunchConfig | null;
  attachPid: number | null;
  capabilities: Capabilities | null;
  sessionError: string | null;
  exitCode: number | null;
  processId: number | null;
  statusMessage: string | null;

  // Execution state
  stopKind: StopKind | null;
  stopReason: string | null;
  stopDescription: string | null;
  threads: ThreadInfo[];
  currentThreadId: number | null;
  frames: StackFrameInfo[];
  framesHasMore: boolean;
  selectedFrameId: number | null;
  scopes: ScopeInfo[];
  variables: Record<string, VariablesPage>;
  expandedRefs: Record<string, boolean>;
  watches: WatchItem[];
  inlineValues: InlineValue[];

  // Breakpoints
  breakpoints: Record<string, SourceBreakpoint[]>;
  functionBreakpoints: FunctionBreakpoint[];
  instructionBreakpoints: InstructionBreakpoint[];
  dataBreakpoints: DataBreakpoint[];
  exceptionFilters: ExceptionFilterState[];
  hitDataBreakpointId: string | null;

  // Output
  consoleLines: ConsoleLine[];
  outputLines: ConsoleLine[];
  notifications: Notification[];
  terminal: TerminalState;

  // UI
  sidebarView: 'explorer' | 'debug';
  sidebarVisible: boolean;
  sidebarWidth: number;
  panelVisible: boolean;
  panelTab: 'problems' | 'output' | 'debugConsole' | 'terminal';
  panelHeight: number;
  editorTabs: EditorTab[];
  activeTabId: string | null;
  editorCursor: { line: number; column: number };
  focusedFile: string | null;
  revealLine: RevealRequest | null;
  inlineValuesEnabled: boolean;
  quickInput: QuickInputState | null;
  contextMenu: ContextMenuState | null;
  launchFile: {
    exists: boolean;
    path: string;
    relativePath: string;
    configs: NormalizedLaunchConfig[];
    errors: string[];
  } | null;
  selectedConfigName: string | null;

  // Explorer
  explorerEntries: Record<string, FileEntry[]>;
  explorerExpanded: Record<string, boolean>;
  explorerLoading: Record<string, boolean>;

  sourceContents: Record<string, string>;
  dirtyFiles: Record<string, boolean>;
  dapTrace: string[];
}

export type { Capabilities, Thread, StackFrame, Scope, Variable, DisassembledInstruction };

export type DebugStore = DebugState & DebugActions;

export interface DebugActions {
  bootstrap(): Promise<void>;
  notify(notification: Omit<Notification, 'id'>): void;
  dismissNotification(id: string): void;
  setContextMenu(menu: ContextMenuState | null): void;
  setQuickInput(input: QuickInputState | null): void;
  setSidebarView(view: 'explorer' | 'debug'): void;
  toggleSidebar(): void;
  togglePanel(tab?: 'problems' | 'output' | 'debugConsole' | 'terminal'): void;
  setPanelTab(tab: 'problems' | 'output' | 'debugConsole' | 'terminal'): void;
  setSidebarWidth(width: number): void;
  setPanelHeight(height: number): void;
  setEditorCursor(line: number, column: number): void;
  setInlineValuesEnabled(enabled: boolean): void;
  refreshLaunchConfigs(focusedFile?: string | null): Promise<void>;
  selectConfig(name: string): void;
  loadDirectory(path: string): Promise<void>;
  toggleDirectory(path: string): Promise<void>;
  refreshExplorer(): Promise<void>;
  collapseExplorer(): void;
  openSource(path: string, line?: number, options?: { pinned?: boolean }): Promise<void>;
  openLaunchJson(): Promise<void>;
  openDisassemblyView(options?: { address?: string }): Promise<void>;
  openMemoryView(options?: { address?: string; label?: string }): Promise<void>;
  activateTab(id: string): void;
  closeTab(id: string): void;
  closeOtherTabs(id: string): void;
  closeAllTabs(): void;
  setTabDirty(id: string, dirty: boolean): void;
  saveTab(id: string): Promise<void>;
  updateLaunchContent(tabId: string, content: string): void;
  updateSourceContent(path: string, content: string, dirty: boolean): void;
  saveActiveTab(): Promise<void>;
  reloadMemory(tabId: string, address?: string): Promise<void>;
  setMemoryAddress(tabId: string, expression: string): Promise<void>;
  reloadDisassembly(tabId: string): Promise<void>;
  loadMoreDisassembly(tabId: string): Promise<void>;
  setDisassemblyFollow(tabId: string, follow: boolean): void;
  startDebugging(configName?: string, options?: { pid?: number }): Promise<void>;
  stopDebugging(): Promise<void>;
  restartDebugging(): Promise<void>;
  continueExecution(): void;
  pauseExecution(): void;
  stepOver(granularity?: 'statement' | 'instruction'): void;
  stepInto(granularity?: 'statement' | 'instruction'): void;
  stepOut(): void;
  runToCursor(path: string, line: number): Promise<void>;
  selectFrame(frameId: number): Promise<void>;
  selectThread(threadId: number): Promise<void>;
  loadMoreFrames(): Promise<void>;
  toggleBreakpoint(path: string, line: number): Promise<void>;
  addConditionalBreakpoint(path: string, line: number): Promise<void>;
  addLogpoint(path: string, line: number): Promise<void>;
  editBreakpointCondition(id: string): Promise<void>;
  editBreakpointHitCount(id: string): Promise<void>;
  editBreakpointLogMessage(id: string): Promise<void>;
  removeBreakpoint(id: string): Promise<void>;
  setBreakpointEnabled(id: string, enabled: boolean): Promise<void>;
  setAllBreakpointsEnabled(enabled: boolean): Promise<void>;
  removeAllBreakpoints(): Promise<void>;
  addFunctionBreakpoint(): Promise<void>;
  editFunctionBreakpointCondition(id: string): Promise<void>;
  editFunctionBreakpointHitCount(id: string): Promise<void>;
  removeFunctionBreakpoint(id: string): Promise<void>;
  setFunctionBreakpointEnabled(id: string, enabled: boolean): Promise<void>;
  addInstructionBreakpoint(address: string): Promise<void>;
  toggleInstructionBreakpoint(address: string): Promise<void>;
  removeInstructionBreakpoint(id: string): Promise<void>;
  removeAllInstructionBreakpoints(): Promise<void>;
  addDataBreakpoint(expression: string, access: WatchpointAccess): Promise<void>;
  promptAddDataBreakpoint(expression?: string): Promise<void>;
  removeDataBreakpoint(id: string): Promise<void>;
  setDataBreakpointEnabled(id: string, enabled: boolean): Promise<void>;
  removeAllDataBreakpoints(): Promise<void>;
  setExceptionFilter(filter: string, enabled: boolean): Promise<void>;
  editExceptionCondition(filter: string): Promise<void>;
  refreshScopes(): Promise<void>;
  toggleVariableExpanded(ref: number): Promise<void>;
  loadMoreVariables(ref: number): Promise<void>;
  setVariableValue(node: VariableNode, value: string): Promise<void>;
  addWatchForVariable(node: VariableNode): void;
  addWatch(expression?: string): Promise<void>;
  removeWatch(id: string): void;
  editWatch(id: string): Promise<void>;
  executeConsoleCommand(text: string): Promise<void>;
  clearConsole(): void;
  clearOutput(): void;
  sendTerminalInput(data: Uint8Array): void;
  resizeTerminal(cols: number, rows: number): void;
  clearTerminal(): void;
  evaluateForHover(expression: string, frameId: number): Promise<{ value: string; type?: string } | null>;
  refreshInlineValues(): Promise<void>;
  openProcessPicker(configName?: string): Promise<void>;
  showDapTrace(): Promise<void>;
}
