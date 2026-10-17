import type { ReactNode } from 'react';

import { runCommand } from '../commands.ts';
import { useDebugStore } from '../debug/store.ts';
import { Codicon, TabIcon } from './Icons.tsx';

export function Tabs(): ReactNode {
  const tabs = useDebugStore((state) => state.editorTabs);
  const activeTabId = useDebugStore((state) => state.activeTabId);
  const activateTab = useDebugStore((state) => state.activateTab);
  const closeTab = useDebugStore((state) => state.closeTab);
  const closeOtherTabs = useDebugStore((state) => state.closeOtherTabs);
  const closeAllTabs = useDebugStore((state) => state.closeAllTabs);
  const setContextMenu = useDebugStore((state) => state.setContextMenu);

  return (
    <div className="tabs-bar" role="tablist">
      <div className="tabs-scroll">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`tab${tab.id === activeTabId ? ' active' : ''}${tab.pinned ? '' : ' preview'}`}
            onClick={() => activateTab(tab.id)}
            onAuxClick={(event) => {
              if (event.button === 1) {
                closeTab(tab.id);
              }
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              setContextMenu({
                x: event.clientX,
                y: event.clientY,
                items: [
                  { label: 'Close', keybinding: 'Ctrl+W', action: () => closeTab(tab.id) },
                  { label: 'Close Others', action: () => closeOtherTabs(tab.id) },
                  { label: 'Close All', action: () => closeAllTabs() },
                ],
              });
            }}
            role="tab"
            aria-selected={tab.id === activeTabId}
          >
            <TabIcon kind={tab.kind} path={tab.path} />
            <span className="tab-title" title={tab.path ?? tab.title}>
              {tab.title}
            </span>
            {tab.dirty ? <span className="tab-dirty">●</span> : null}
            <button
              className="tab-close"
              title="Close (Ctrl+W)"
              onClick={(event) => {
                event.stopPropagation();
                closeTab(tab.id);
              }}
            >
              <Codicon name={tab.dirty ? 'circle-filled' : 'close'} />
            </button>
          </div>
        ))}
      </div>
      <div className="tabs-actions">
        <button
          title="More Actions…"
          onClick={(event) => {
            const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
            setContextMenu({
              x: rect.right - 180,
              y: rect.bottom + 2,
              items: [
                { label: 'Close All Editors', action: () => closeAllTabs() },
                { label: 'Save All Editors', action: () => runCommand('file.saveAll') },
              ],
            });
          }}
        >
          <Codicon name="ellipsis" />
        </button>
      </div>
    </div>
  );
}
