import { useCallback, type ReactNode } from 'react';

import { useDebugStore } from '../debug/store.ts';
import { DebugView } from './debug/DebugView.tsx';
import { ExplorerView } from './ExplorerView.tsx';
import { Codicon } from './Icons.tsx';

export function Sidebar(): ReactNode {
  const visible = useDebugStore((state) => state.sidebarVisible);
  const width = useDebugStore((state) => state.sidebarWidth);
  const view = useDebugStore((state) => state.sidebarView);
  const setSidebarWidth = useDebugStore((state) => state.setSidebarWidth);
  const refreshExplorer = useDebugStore((state) => state.refreshExplorer);
  const collapseExplorer = useDebugStore((state) => state.collapseExplorer);
  const openLaunchJson = useDebugStore((state) => state.openLaunchJson);
  const setContextMenu = useDebugStore((state) => state.setContextMenu);
  const setInlineValuesEnabled = useDebugStore((state) => state.setInlineValuesEnabled);
  const inlineValuesEnabled = useDebugStore((state) => state.inlineValuesEnabled);
  const showDapTrace = useDebugStore((state) => state.showDapTrace);
  const clearConsole = useDebugStore((state) => state.clearConsole);

  const startResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = width;
      const onMove = (moveEvent: PointerEvent) => {
        setSidebarWidth(startWidth + moveEvent.clientX - startX);
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        document.body.classList.remove('resizing');
      };
      document.body.classList.add('resizing');
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [setSidebarWidth, width],
  );

  if (!visible) {
    return null;
  }

  const title = view === 'explorer' ? 'EXPLORER' : 'RUN AND DEBUG';

  return (
    <div className="sidebar" style={{ width }}>
      <div className="sidebar-header">
        <span className="sidebar-title">{title}</span>
        <div className="sidebar-actions">
          {view === 'explorer' ? (
            <>
              <button title="Refresh Explorer" onClick={() => void refreshExplorer()}>
                <Codicon name="refresh" />
              </button>
              <button title="Collapse Folders in Explorer" onClick={collapseExplorer}>
                <Codicon name="collapse-all" />
              </button>
            </>
          ) : (
            <>
              <button title="Open launch.json" onClick={() => void openLaunchJson()}>
                <Codicon name="gear" />
              </button>
              <button
                title="Views and More Actions…"
                onClick={(event) => {
                  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
                  setContextMenu({
                    x: rect.right - 220,
                    y: rect.bottom + 2,
                    items: [
                      { label: 'Open launch.json', action: () => void openLaunchJson() },
                      {
                        label: inlineValuesEnabled ? 'Hide Inline Values' : 'Show Inline Values',
                        action: () => setInlineValuesEnabled(!inlineValuesEnabled),
                      },
                      { separator: true },
                      { label: 'Clear Debug Console', action: () => clearConsole() },
                      { label: 'Show DAP Trace', action: () => void showDapTrace() },
                    ],
                  });
                }}
              >
                <Codicon name="ellipsis" />
              </button>
            </>
          )}
        </div>
      </div>
      <div className="sidebar-content">{view === 'explorer' ? <ExplorerView /> : <DebugView />}</div>
      <div className="sidebar-resizer" onPointerDown={startResize} role="separator" aria-orientation="vertical" />
    </div>
  );
}
