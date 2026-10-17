import type { ReactNode } from 'react';

import { languageLabelForPath, stopKindLabel } from '../debug/format.ts';
import { useDebugStore } from '../debug/store.ts';
import { Codicon } from './Icons.tsx';

export function StatusBar(): ReactNode {
  const status = useDebugStore((state) => state.status);
  const stopKind = useDebugStore((state) => state.stopKind);
  const statusMessage = useDebugStore((state) => state.statusMessage);
  const activeTabId = useDebugStore((state) => state.activeTabId);
  const editorTabs = useDebugStore((state) => state.editorTabs);
  const cursor = useDebugStore((state) => state.editorCursor);
  const environment = useDebugStore((state) => state.environment);
  const launchFile = useDebugStore((state) => state.launchFile);
  const setSidebarView = useDebugStore((state) => state.setSidebarView);
  const setPanelTab = useDebugStore((state) => state.setPanelTab);

  const activeTab = editorTabs.find((tab) => tab.id === activeTabId);
  const debugging = status !== 'inactive' && status !== 'error';
  const debugLabel =
    status === 'stopped'
      ? stopKindLabel(stopKind)
      : status === 'running'
        ? 'Running'
        : status === 'initializing'
          ? 'Starting…'
          : status === 'terminated'
            ? 'Terminated'
            : 'Debugging';

  const problemCount = launchFile?.errors.length ?? 0;
  const showCursor = activeTab?.kind === 'source' || activeTab?.kind === 'launch';

  return (
    <div className="statusbar">
      <div className="statusbar-left">
        {debugging ? (
          <button
            className={`statusbar-item statusbar-debug${status === 'stopped' ? ' paused' : ''}`}
            onClick={() => setSidebarView('debug')}
            title={statusMessage ?? debugLabel}
          >
            <Codicon name={status === 'stopped' ? 'debug-pause' : 'debug-alt'} />
            <span>{debugLabel}</span>
          </button>
        ) : (
          <span className="statusbar-item">
            <Codicon name="debug-alt" />
            <span>gdb-client</span>
          </span>
        )}
      </div>

      <div className="statusbar-right">
        <button className="statusbar-item" onClick={() => setPanelTab('problems')} title="Problems">
          <Codicon name="error" />
          <span>{problemCount}</span>
          <Codicon name="warning" />
          <span>0</span>
        </button>
        {showCursor ? (
          <span className="statusbar-item" title="Cursor position">
            Ln {cursor.line}, Col {cursor.column}
          </span>
        ) : null}
        <span className="statusbar-item">Spaces: 4</span>
        <span className="statusbar-item">UTF-8</span>
        <span className="statusbar-item">LF</span>
        <span className="statusbar-item">
          {activeTab?.kind === 'source' && activeTab.path
            ? languageLabelForPath(activeTab.path)
            : activeTab?.kind === 'launch'
              ? 'JSON with Comments'
              : activeTab?.kind === 'disassembly'
                ? 'Disassembly'
                : activeTab?.kind === 'memory'
                  ? 'Memory'
                  : 'Plain Text'}
        </span>
        <span
          className="statusbar-item statusbar-adapter"
          title={environment?.version ?? 'gdb not found'}
        >
          <Codicon name="beaker" />
          <span>{environment?.available ? 'gdb' : 'gdb missing'}</span>
        </span>
      </div>
    </div>
  );
}
