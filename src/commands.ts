import { applyEdits, modify, parse } from 'jsonc-parser';

import { api } from './api.ts';
import { basename, dirname } from './debug/format.ts';
import { nextId } from './debug/runtime.ts';
import { useDebugStore } from './debug/store.ts';
import type { EditorTab } from './debug/types.ts';
import { openCommandPalette } from './ui/events.ts';

export interface AppCommand {
  id: string;
  label: string;
  category: string;
  keybinding?: string;
  run: () => void;
}

function activeSourceLocation(): { path: string; line: number } | null {
  const state = useDebugStore.getState();
  const tab = state.editorTabs.find((entry) => entry.id === state.activeTabId);
  if (!tab || tab.kind !== 'source' || !tab.path) {
    return null;
  }
  return { path: tab.path, line: state.editorCursor.line };
}

const TEMPLATE_CONFIGURATION = {
  name: 'Debug (gdb)',
  type: 'cppdbg',
  request: 'launch',
  program: '${workspaceFolder}/a.out',
  args: [],
  cwd: '${workspaceFolder}',
  stopAtEntry: false,
  MIMode: 'gdb',
};

function addConfigurationToContent(content: string): string {
  if (!content.trim()) {
    return JSON.stringify({ version: '0.2.0', configurations: [TEMPLATE_CONFIGURATION] }, null, 2);
  }
  const parsed = parse(content, [], { allowTrailingComma: true });
  const configurations =
    parsed && typeof parsed === 'object' && Array.isArray((parsed as { configurations?: unknown }).configurations)
      ? ((parsed as { configurations: unknown[] }).configurations)
      : [];
  const edits = modify(content, ['configurations', configurations.length], TEMPLATE_CONFIGURATION, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  return applyEdits(content, edits);
}

async function openNewFilePicker(): Promise<void> {
  const state = useDebugStore.getState();
  try {
    const { files } = await api.files();
    state.setQuickInput({
      title: 'Go to File',
      placeholder: 'Search by file name',
      value: '',
      items: files.map((file) => ({
        label: basename(file),
        description: dirname(file),
        icon: 'file',
        action: () => {
          state.setQuickInput(null);
          const root = state.workspace?.root ?? '';
          void state.openSource(`${root}/${file}`, undefined, { pinned: true });
        },
      })),
      onSubmit: () => undefined,
    });
  } catch (error) {
    state.notify({
      severity: 'error',
      message: 'Could not list workspace files',
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

async function saveAllTabs(): Promise<void> {
  const state = useDebugStore.getState();
  for (const tab of state.editorTabs) {
    if (tab.dirty) {
      await state.saveTab(tab.id);
    }
  }
}

function openWelcomeTab(): void {
  const state = useDebugStore.getState();
  const existing = state.editorTabs.find((tab) => tab.kind === 'welcome');
  if (existing) {
    state.activateTab(existing.id);
    return;
  }
  const tab: EditorTab = {
    id: nextId('tab'),
    kind: 'welcome',
    title: 'Welcome',
    pinned: true,
    dirty: false,
  };
  useDebugStore.setState({ editorTabs: [...state.editorTabs, tab], activeTabId: tab.id });
}

function withActiveSource(
  run: (location: { path: string; line: number }) => void,
  commandLabel: string,
): void {
  const location = activeSourceLocation();
  if (!location) {
    useDebugStore.getState().notify({
      severity: 'info',
      message: `${commandLabel} needs an open source file.`,
    });
    return;
  }
  run(location);
}

export function getCommands(): AppCommand[] {
  const store = () => useDebugStore.getState();
  return [
    {
      id: 'run.startOrContinue',
      label: 'Start Debugging / Continue',
      category: 'Run',
      keybinding: 'F5',
      run: () => {
        const state = store();
        if (state.status === 'stopped') {
          state.continueExecution();
        } else if (state.status === 'inactive' || state.status === 'error' || state.status === 'terminated') {
          void state.startDebugging();
        }
      },
    },
    { id: 'run.stop', label: 'Stop Debugging', category: 'Run', keybinding: 'Shift+F5', run: () => void store().stopDebugging() },
    {
      id: 'run.restart',
      label: 'Restart Debugging',
      category: 'Run',
      keybinding: 'Ctrl+Shift+F5',
      run: () => void store().restartDebugging(),
    },
    { id: 'run.pause', label: 'Pause', category: 'Run', keybinding: 'F6', run: () => store().pauseExecution() },
    { id: 'run.stepOver', label: 'Step Over', category: 'Run', keybinding: 'F10', run: () => store().stepOver() },
    { id: 'run.stepInto', label: 'Step Into', category: 'Run', keybinding: 'F11', run: () => store().stepInto() },
    { id: 'run.stepOut', label: 'Step Out', category: 'Run', keybinding: 'Shift+F11', run: () => store().stepOut() },
    {
      id: 'run.runToCursor',
      label: 'Run to Cursor',
      category: 'Run',
      keybinding: 'Ctrl+F10',
      run: () =>
        withActiveSource(
          (location) => void store().runToCursor(location.path, location.line),
          'Run to Cursor',
        ),
    },
    {
      id: 'run.attach',
      label: 'Attach to Process',
      category: 'Run',
      run: () => {
        const state = store();
        const attachConfig = state.launchFile?.configs.find((config) => config.request === 'attach');
        if (!attachConfig) {
          state.notify({
            severity: 'warning',
            message: 'No attach configuration found',
            detail: 'Add a configuration with "request": "attach" to .vscode/launch.json.',
          });
          return;
        }
        state.selectConfig(attachConfig.name);
        void state.openProcessPicker(attachConfig.name);
      },
    },
    {
      id: 'debug.toggleBreakpoint',
      label: 'Toggle Breakpoint',
      category: 'Debug',
      keybinding: 'F9',
      run: () =>
        withActiveSource(
          (location) => void store().toggleBreakpoint(location.path, location.line),
          'Toggle Breakpoint',
        ),
    },
    {
      id: 'debug.addConditionalBreakpoint',
      label: 'Add Conditional Breakpoint',
      category: 'Debug',
      run: () =>
        withActiveSource(
          (location) => void store().addConditionalBreakpoint(location.path, location.line),
          'Add Conditional Breakpoint',
        ),
    },
    {
      id: 'debug.addLogpoint',
      label: 'Add Logpoint',
      category: 'Debug',
      run: () =>
        withActiveSource(
          (location) => void store().addLogpoint(location.path, location.line),
          'Add Logpoint',
        ),
    },
    {
      id: 'debug.addFunctionBreakpoint',
      label: 'Add Function Breakpoint',
      category: 'Debug',
      run: () => void store().addFunctionBreakpoint(),
    },
    {
      id: 'debug.addDataBreakpoint',
      label: 'Add Data Breakpoint',
      category: 'Debug',
      run: () => void store().promptAddDataBreakpoint(),
    },
    {
      id: 'debug.removeAllDataBreakpoints',
      label: 'Remove All Data Breakpoints',
      category: 'Debug',
      run: () => void store().removeAllDataBreakpoints(),
    },
    {
      id: 'debug.removeAllBreakpoints',
      label: 'Remove All Breakpoints',
      category: 'Debug',
      run: () => void store().removeAllBreakpoints(),
    },
    {
      id: 'debug.enableAllBreakpoints',
      label: 'Enable All Breakpoints',
      category: 'Debug',
      run: () => void store().setAllBreakpointsEnabled(true),
    },
    {
      id: 'debug.disableAllBreakpoints',
      label: 'Disable All Breakpoints',
      category: 'Debug',
      run: () => void store().setAllBreakpointsEnabled(false),
    },
    {
      id: 'debug.openDisassembly',
      label: 'Open Disassembly View',
      category: 'Debug',
      run: () => void store().openDisassemblyView(),
    },
    {
      id: 'debug.viewMemory',
      label: 'View Memory',
      category: 'Debug',
      run: () => void store().openMemoryView(),
    },
    {
      id: 'debug.clearConsole',
      label: 'Clear Debug Console',
      category: 'Debug',
      run: () => {
        store().clearConsole();
        store().setPanelTab('debugConsole');
      },
    },
    {
      id: 'debug.showTrace',
      label: 'Show DAP Trace',
      category: 'Debug',
      run: () => void store().showDapTrace(),
    },
    {
      id: 'debug.toggleInlineValues',
      label: 'Toggle Inline Values',
      category: 'Debug',
      run: () => store().setInlineValuesEnabled(!store().inlineValuesEnabled),
    },
    {
      id: 'debug.addConfiguration',
      label: 'Add Configuration to launch.json',
      category: 'Debug',
      run: () => {
        void (async () => {
          const state = store();
          await state.openLaunchJson();
          const tab = useDebugStore.getState().editorTabs.find((entry) => entry.kind === 'launch');
          if (!tab) {
            return;
          }
          const updated = addConfigurationToContent(tab.launchContent ?? '');
          useDebugStore.getState().updateLaunchContent(tab.id, updated);
          await useDebugStore.getState().saveTab(tab.id);
        })();
      },
    },
    {
      id: 'file.openLaunchJson',
      label: 'Open launch.json',
      category: 'File',
      run: () => void store().openLaunchJson(),
    },
    { id: 'file.save', label: 'Save', category: 'File', keybinding: 'Ctrl+S', run: () => void store().saveActiveTab() },
    { id: 'file.saveAll', label: 'Save All', category: 'File', run: () => void saveAllTabs() },
    {
      id: 'file.closeEditor',
      label: 'Close Editor',
      category: 'File',
      keybinding: 'Ctrl+W',
      run: () => {
        const state = store();
        if (state.activeTabId) {
          state.closeTab(state.activeTabId);
        }
      },
    },
    {
      id: 'file.closeAllEditors',
      label: 'Close All Editors',
      category: 'File',
      run: () => store().closeAllTabs(),
    },
    {
      id: 'view.explorer',
      label: 'Explorer',
      category: 'View',
      keybinding: 'Ctrl+Shift+E',
      run: () => store().setSidebarView('explorer'),
    },
    {
      id: 'view.debug',
      label: 'Run and Debug',
      category: 'View',
      keybinding: 'Ctrl+Shift+D',
      run: () => store().setSidebarView('debug'),
    },
    {
      id: 'view.debugConsole',
      label: 'Debug Console',
      category: 'View',
      keybinding: 'Ctrl+Shift+Y',
      run: () => store().setPanelTab('debugConsole'),
    },
    { id: 'view.output', label: 'Output', category: 'View', run: () => store().setPanelTab('output') },
    { id: 'view.problems', label: 'Problems', category: 'View', run: () => store().setPanelTab('problems') },
    {
      id: 'view.terminal',
      label: 'Terminal',
      category: 'View',
      run: () => store().setPanelTab('terminal'),
    },
    {
      id: 'view.togglePanel',
      label: 'Toggle Panel',
      category: 'View',
      keybinding: 'Ctrl+`',
      run: () => store().togglePanel(),
    },
    {
      id: 'view.toggleSidebar',
      label: 'Toggle Primary Side Bar',
      category: 'View',
      keybinding: 'Ctrl+B',
      run: () => store().toggleSidebar(),
    },
    {
      id: 'view.commandPalette',
      label: 'Command Palette',
      category: 'View',
      keybinding: 'Ctrl+Shift+P',
      run: () => openCommandPalette(),
    },
    { id: 'view.welcome', label: 'Welcome', category: 'View', run: () => openWelcomeTab() },
    {
      id: 'go.file',
      label: 'Go to File…',
      category: 'Go',
      keybinding: 'Ctrl+P',
      run: () => void openNewFilePicker(),
    },
    {
      id: 'help.about',
      label: 'About gdb-client',
      category: 'Help',
      run: () => {
        const state = store();
        state.notify({
          severity: 'info',
          message: 'gdb-client 0.1.0',
          detail: [
            state.environment?.version ?? 'gdb not found',
            'Debug Adapter Protocol over gdb --interpreter=dap',
          ].join('\n'),
        });
      },
    },
    {
      id: 'help.shortcuts',
      label: 'Keyboard Shortcuts',
      category: 'Help',
      run: () => {
        const shortcuts = getCommands()
          .filter((command) => command.keybinding)
          .map((command) => ({ label: command.keybinding as string, description: command.label, action: () => store().setQuickInput(null) }));
        store().setQuickInput({
          title: 'Keyboard Shortcuts',
          placeholder: 'Debugger shortcuts',
          value: '',
          items: shortcuts,
          onSubmit: () => undefined,
        });
      },
    },
  ];
}

export function runCommand(id: string): void {
  const command = getCommands().find((entry) => entry.id === id);
  if (command) {
    command.run();
  }
}

export function commandById(id: string): AppCommand | undefined {
  return getCommands().find((entry) => entry.id === id);
}
