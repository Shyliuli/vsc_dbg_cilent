import { create } from 'zustand';

import { api } from '../api.ts';
import { basename } from './format.ts';
import { createDebugController } from './controller.ts';
import { nextId, setCachedFileText } from './runtime.ts';
import type {
  ContextMenuState,
  DebugStore,
  EditorTab,
  QuickInputState,
  RevealRequest,
} from './types.ts';

const DEFAULT_LAUNCH_JSON = `{
  // Use this file to configure the debugger.
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Debug",
      "type": "cppdbg",
      "request": "launch",
      "program": "\${workspaceFolder}/a.out",
      "args": [],
      "cwd": "\${workspaceFolder}",
      "stopAtEntry": false,
      "MIMode": "gdb"
    }
  ]
}
`;

function welcomeTab(): EditorTab {
  return {
    id: nextId('tab'),
    kind: 'welcome',
    title: 'Welcome',
    pinned: true,
    dirty: false,
  };
}

function createInitialState() {
  return {
    bootstrapped: false,
    workspace: null,
    environment: null,

    // session
    status: 'inactive' as const,
    activeConfig: null,
    attachPid: null,
    capabilities: null,
    sessionError: null,
    exitCode: null,
    processId: null,
    statusMessage: null,

    stopKind: null,
    stopReason: null,
    stopDescription: null,
    threads: [],
    currentThreadId: null,
    frames: [],
    framesHasMore: false,
    selectedFrameId: null,
    scopes: [],
    variables: {},
    expandedRefs: {},
    watches: [],
    inlineValues: [],

    breakpoints: {},
    functionBreakpoints: [],
    instructionBreakpoints: [],
    dataBreakpoints: [],
    exceptionFilters: [],
    hitDataBreakpointId: null,

    consoleLines: [],
    outputLines: [],
    notifications: [],
    terminal: {
      available: false,
      slavePath: null,
      chunks: [],
      epoch: 0,
      exited: false,
      error: null,
      console: null,
    },

    sidebarView: 'debug' as const,
    sidebarVisible: true,
    sidebarWidth: 300,
    panelVisible: true,
    panelTab: 'debugConsole' as const,
    panelHeight: 220,
    editorTabs: [] as EditorTab[],
    activeTabId: null,
    editorCursor: { line: 1, column: 1 },
    focusedFile: null,
    revealLine: null,
    inlineValuesEnabled: true,
    quickInput: null,
    contextMenu: null,
    launchFile: null,
    selectedConfigName: null,

    explorerEntries: {},
    explorerExpanded: { '': true } as Record<string, boolean>,
    explorerLoading: {},

    sourceContents: {},
    dirtyFiles: {},
    dapTrace: [],
  };
}

export const useDebugStore = create<DebugStore>()((set, get) => {
  const controller = createDebugController(set, get);

  function ensureWelcomeTab(): void {
    if (get().editorTabs.length === 0) {
      const tab = welcomeTab();
      set({ editorTabs: [tab], activeTabId: tab.id });
    }
  }

  function saveTabInternal(tab: EditorTab): Promise<void> {
    if (tab.kind === 'launch') {
      const content = tab.launchContent ?? '';
      return api
        .saveLaunch(content, get().focusedFile)
        .then((result) => {
          set((state) => ({
            launchFile: {
              exists: result.exists,
              path: result.path,
              relativePath: result.relativePath,
              configs: result.configs,
              errors: result.errors,
            },
            selectedConfigName:
              result.configs.some((config) => config.name === state.selectedConfigName)
                ? state.selectedConfigName
                : (result.configs[0]?.name ?? null),
            editorTabs: state.editorTabs.map((entry) =>
              entry.id === tab.id
                ? { ...entry, dirty: false, launchContent: content, launchSavedContent: content }
                : entry,
            ),
          }));
          if (result.errors.length > 0) {
            get().notify({
              severity: 'error',
              message: 'launch.json contains errors',
              detail: result.errors.join('\n'),
            });
          }
        })
        .catch((error: unknown) => {
          get().notify({
            severity: 'error',
            message: 'Could not save launch.json',
            detail: error instanceof Error ? error.message : String(error),
          });
        });
    }

    if (!tab.path) {
      return Promise.resolve();
    }
    const content = get().sourceContents[tab.path];
    if (content === undefined) {
      return Promise.resolve();
    }
    return api
      .saveFile(tab.path, content)
      .then(() => {
        setCachedFileText(tab.path as string, content);
        set((state) => ({
          dirtyFiles: { ...state.dirtyFiles, [tab.path as string]: false },
          editorTabs: state.editorTabs.map((entry) =>
            entry.id === tab.id ? { ...entry, dirty: false } : entry,
          ),
        }));
      })
      .catch((error: unknown) => {
        get().notify({
          severity: 'error',
          message: `Could not save ${basename(tab.path as string)}`,
          detail: error instanceof Error ? error.message : String(error),
        });
      });
  }

  function confirmClose(tab: EditorTab): void {
    const save = () => {
      get().setQuickInput(null);
      void saveTabInternal(tab).then(() => get().closeTab(tab.id));
    };
    const discard = () => {
      get().setQuickInput(null);
      set((state) => ({
        editorTabs: state.editorTabs.filter((entry) => entry.id !== tab.id),
        activeTabId:
          state.activeTabId === tab.id
            ? (state.editorTabs.find((entry) => entry.id !== tab.id)?.id ?? null)
            : state.activeTabId,
      }));
      ensureWelcomeTab();
    };
    get().setQuickInput({
      title: `Do you want to save the changes you made to ${tab.title}?`,
      prompt: "Your changes will be lost if you don't save them.",
      value: '',
      items: [
        { label: 'Save', action: save },
        { label: "Don't Save", action: discard },
        { label: 'Cancel', action: () => get().setQuickInput(null) },
      ],
      onSubmit: () => {
        // The file name is not an input; the picker actions do the work.
      },
    });
  }

  return {
    ...createInitialState(),
    ...controller,

    async bootstrap() {
      if (get().bootstrapped) {
        return;
      }
      try {
        const [workspace, environment, launchFile] = await Promise.all([
          api.workspace(),
          api.environment(),
          api.launch(),
        ]);
        set({
          workspace: { root: workspace.root, name: workspace.name },
          environment: {
            gdbPath: environment.gdbPath,
            version: environment.version,
            available: environment.available,
          },
          launchFile,
          selectedConfigName: launchFile.configs[0]?.name ?? null,
          bootstrapped: true,
          outputLines: [
            {
              id: nextId('out'),
              kind: 'info' as const,
              text: `gdb-client 0.1.0 — workspace ${workspace.root}`,
              time: Date.now(),
            },
            {
              id: nextId('out'),
              kind: 'info' as const,
              text: environment.available
                ? `debug adapter: ${environment.version} (gdb --interpreter=dap)`
                : 'debug adapter: gdb was not found on PATH',
              time: Date.now(),
            },
          ],
        });
        if (!environment.available) {
          get().notify({
            severity: 'error',
            message: 'gdb was not found',
            detail: environment.error ?? 'Install gdb (version 14 or newer) and make sure it is on PATH.',
          });
        }
        if (launchFile.errors.length > 0) {
          get().notify({
            severity: 'warning',
            message: '.vscode/launch.json has errors',
            detail: launchFile.errors.join('\n'),
          });
        }
        // Drop a stale welcome tab from a previous bootstrap attempt.
        if (get().editorTabs.length === 0) {
          const tab = welcomeTab();
          set({ editorTabs: [tab], activeTabId: tab.id });
        }
        await get().loadDirectory('');
      } catch (error) {
        set({ bootstrapped: true });
        get().notify({
          severity: 'error',
          message: 'Could not reach the debugger backend',
          detail: error instanceof Error ? error.message : String(error),
        });
        ensureWelcomeTab();
      }
    },

    notify(notification) {
      const id = nextId('notification');
      set((state) => ({
        notifications: [...state.notifications, { ...notification, id }].slice(-6),
      }));
      if (notification.severity !== 'error') {
        window.setTimeout(() => get().dismissNotification(id), 6000);
      }
    },

    dismissNotification(id) {
      set((state) => ({ notifications: state.notifications.filter((entry) => entry.id !== id) }));
    },

    setContextMenu(menu: ContextMenuState | null) {
      set({ contextMenu: menu });
    },

    setQuickInput(input: QuickInputState | null) {
      set({ quickInput: input });
    },

    setSidebarView(view) {
      set({ sidebarView: view, sidebarVisible: true });
    },

    toggleSidebar() {
      set((state) => ({ sidebarVisible: !state.sidebarVisible }));
    },

    togglePanel(tab) {
      set((state) => {
        if (state.panelVisible && (tab === undefined || tab === state.panelTab)) {
          return { panelVisible: false };
        }
        return { panelVisible: true, panelTab: tab ?? state.panelTab };
      });
    },

    setPanelTab(tab) {
      set({ panelTab: tab, panelVisible: true });
    },

    setSidebarWidth(width) {
      set({ sidebarWidth: Math.min(700, Math.max(200, width)) });
    },

    setPanelHeight(height) {
      set({ panelHeight: Math.min(800, Math.max(100, height)) });
    },

    setEditorCursor(line, column) {
      set({ editorCursor: { line, column } });
    },

    setInlineValuesEnabled(enabled) {
      set({ inlineValuesEnabled: enabled });
      if (enabled) {
        void controller.refreshInlineValues();
      } else {
        set({ inlineValues: [] });
      }
    },

    async refreshLaunchConfigs(focusedFile) {
      try {
        const launchFile = await api.launch(focusedFile ?? get().focusedFile);
        set((state) => ({
          launchFile,
          selectedConfigName: launchFile.configs.some(
            (config) => config.name === state.selectedConfigName,
          )
            ? state.selectedConfigName
            : (launchFile.configs[0]?.name ?? null),
        }));
      } catch (error) {
        get().notify({
          severity: 'error',
          message: 'Could not read .vscode/launch.json',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    },

    selectConfig(name) {
      set({ selectedConfigName: name });
    },

    async loadDirectory(path) {
      if (get().explorerLoading[path]) {
        return;
      }
      set((state) => ({
        explorerLoading: { ...state.explorerLoading, [path]: true },
        explorerExpanded: { ...state.explorerExpanded, [path]: true },
      }));
      try {
        const { entries } = await api.tree(path);
        set((state) => ({
          explorerEntries: { ...state.explorerEntries, [path]: entries },
          explorerLoading: { ...state.explorerLoading, [path]: false },
        }));
      } catch (error) {
        set((state) => ({ explorerLoading: { ...state.explorerLoading, [path]: false } }));
        get().notify({
          severity: 'error',
          message: `Could not open directory ${path || '.'}`,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    },

    async toggleDirectory(path) {
      if (get().explorerExpanded[path]) {
        set((state) => ({ explorerExpanded: { ...state.explorerExpanded, [path]: false } }));
        return;
      }
      await get().loadDirectory(path);
    },

    async refreshExplorer() {
      const expanded = Object.entries(get().explorerExpanded)
        .filter(([, value]) => value)
        .map(([path]) => path)
        .sort((a, b) => a.length - b.length);
      for (const path of expanded) {
        await get().loadDirectory(path);
      }
      if (!expanded.includes('')) {
        await get().loadDirectory('');
      }
    },

    collapseExplorer() {
      set({ explorerExpanded: { '': true } });
    },

    async openSource(path, line, options) {
      const pinned = options?.pinned ?? false;
      set((state) => {
        const existing = state.editorTabs.find((tab) => tab.kind === 'source' && tab.path === path);
        if (existing) {
          return {
            editorTabs: state.editorTabs.map((tab) =>
              tab.id === existing.id ? { ...tab, pinned: tab.pinned || pinned } : tab,
            ),
            activeTabId: existing.id,
            focusedFile: path,
          };
        }
        const tab: EditorTab = {
          id: nextId('tab'),
          kind: 'source',
          title: basename(path),
          path,
          pinned,
          dirty: false,
        };
        const tabs = [...state.editorTabs];
        const activeIndex = tabs.findIndex((entry) => entry.id === state.activeTabId);
        const active = activeIndex >= 0 ? tabs[activeIndex] : undefined;
        const canReplaceActive =
          !pinned &&
          active !== undefined &&
          !active.pinned &&
          (active.kind === 'welcome' || !state.dirtyFiles[active.path ?? '']);
        if (canReplaceActive) {
          tabs.splice(activeIndex, 1, tab);
        } else {
          tabs.push(tab);
        }
        return { editorTabs: tabs, activeTabId: tab.id, focusedFile: path };
      });
      if (line !== undefined) {
        set((state) => ({
          revealLine: {
            path,
            line,
            token: (state.revealLine?.token ?? 0) + 1,
          } satisfies RevealRequest,
        }));
      }
    },

    async openLaunchJson() {
      const launchPath = get().launchFile?.path;
      const workspaceRoot = get().workspace?.root;
      if (!launchPath && !workspaceRoot) {
        return;
      }
      const targetPath = launchPath ?? `${workspaceRoot}/.vscode/launch.json`;
      const existing = get().editorTabs.find((tab) => tab.kind === 'launch');
      if (existing && existing.dirty) {
        set({ activeTabId: existing.id });
        return;
      }
      let content = DEFAULT_LAUNCH_JSON;
      let savedContent = DEFAULT_LAUNCH_JSON;
      if (get().launchFile?.exists) {
        try {
          const file = await api.file(targetPath);
          content = file.content;
          savedContent = file.content;
        } catch (error) {
          get().notify({
            severity: 'error',
            message: 'Could not read launch.json',
            detail: error instanceof Error ? error.message : String(error),
          });
          return;
        }
      }
      if (existing) {
        set((state) => ({
          activeTabId: existing.id,
          editorTabs: state.editorTabs.map((tab) =>
            tab.id === existing.id
              ? { ...tab, launchContent: content, launchSavedContent: savedContent, dirty: false }
              : tab,
          ),
        }));
        return;
      }
      const tab: EditorTab = {
        id: nextId('tab'),
        kind: 'launch',
        title: 'launch.json',
        path: targetPath,
        pinned: true,
        dirty: false,
        launchContent: content,
        launchSavedContent: savedContent,
      };
      set((state) => ({ editorTabs: [...state.editorTabs, tab], activeTabId: tab.id }));
    },

    activateTab(id) {
      const tab = get().editorTabs.find((entry) => entry.id === id);
      if (!tab) {
        return;
      }
      set({
        activeTabId: id,
        focusedFile: tab.kind === 'source' ? (tab.path ?? null) : get().focusedFile,
      });
    },

    closeTab(id) {
      const tab = get().editorTabs.find((entry) => entry.id === id);
      if (!tab) {
        return;
      }
      if (tab.dirty) {
        confirmClose(tab);
        return;
      }
      const wasActive = get().activeTabId === id;
      set((state) => {
        const index = state.editorTabs.findIndex((entry) => entry.id === id);
        const remaining = state.editorTabs.filter((entry) => entry.id !== id);
        const nextActive = remaining[Math.min(index, remaining.length - 1)] ?? remaining[0];
        return {
          editorTabs: remaining,
          activeTabId: wasActive ? (nextActive?.id ?? null) : state.activeTabId,
        };
      });
      if (get().editorTabs.length === 0 && tab.kind !== 'welcome') {
        ensureWelcomeTab();
      }
    },

    closeOtherTabs(id) {
      set((state) => {
        const remaining = state.editorTabs.filter((entry) => entry.id === id || entry.dirty);
        return { editorTabs: remaining, activeTabId: id };
      });
    },

    closeAllTabs() {
      set((state) => {
        const remaining = state.editorTabs.filter((entry) => entry.dirty);
        return {
          editorTabs: remaining,
          activeTabId: remaining[remaining.length - 1]?.id ?? null,
        };
      });
      ensureWelcomeTab();
    },

    setTabDirty(id, dirty) {
      set((state) => ({
        editorTabs: state.editorTabs.map((tab) => (tab.id === id ? { ...tab, dirty } : tab)),
      }));
    },

    async saveTab(id) {
      const tab = get().editorTabs.find((entry) => entry.id === id);
      if (!tab) {
        return;
      }
      await saveTabInternal(tab);
    },

    async saveActiveTab() {
      const activeTabId = get().activeTabId;
      if (activeTabId) {
        await get().saveTab(activeTabId);
      }
    },

    updateLaunchContent(tabId, content) {
      set((state) => ({
        editorTabs: state.editorTabs.map((tab) =>
          tab.id === tabId && tab.kind === 'launch'
            ? { ...tab, launchContent: content, dirty: content !== (tab.launchSavedContent ?? '') }
            : tab,
        ),
      }));
    },

    updateSourceContent(path, content, dirty) {
      setCachedFileText(path, content);
      set((state) => ({
        sourceContents: { ...state.sourceContents, [path]: content },
        dirtyFiles: { ...state.dirtyFiles, [path]: dirty },
        editorTabs: state.editorTabs.map((tab) =>
          tab.kind === 'source' && tab.path === path ? { ...tab, dirty } : tab,
        ),
      }));
    },
  };
});

export function selectActiveTab(state: DebugStore): EditorTab | undefined {
  return state.editorTabs.find((tab) => tab.id === state.activeTabId);
}

export function breadcrumbSegments(path: string): string[] {
  return path.split('/').filter(Boolean);
}
