import type { ReactNode } from 'react';

import { useDebugStore } from '../debug/store.ts';
import { openCommandPalette } from '../ui/events.ts';
import { Codicon } from './Icons.tsx';

export function ActivityBar(): ReactNode {
  const sidebarView = useDebugStore((state) => state.sidebarView);
  const sidebarVisible = useDebugStore((state) => state.sidebarVisible);
  const setSidebarView = useDebugStore((state) => state.setSidebarView);
  const toggleSidebar = useDebugStore((state) => state.toggleSidebar);
  const status = useDebugStore((state) => state.status);

  const activate = (view: 'explorer' | 'debug') => {
    if (sidebarVisible && sidebarView === view) {
      toggleSidebar();
      return;
    }
    setSidebarView(view);
  };

  return (
    <div className="activitybar" role="tablist" aria-label="Activity Bar">
      <button
        className={`activitybar-item${sidebarVisible && sidebarView === 'explorer' ? ' active' : ''}`}
        onClick={() => activate('explorer')}
        title="Explorer (Ctrl+Shift+E)"
        role="tab"
        aria-selected={sidebarVisible && sidebarView === 'explorer'}
      >
        <Codicon name="files" />
      </button>
      <button
        className={`activitybar-item${sidebarVisible && sidebarView === 'debug' ? ' active' : ''}`}
        onClick={() => activate('debug')}
        title="Run and Debug (Ctrl+Shift+D)"
        role="tab"
        aria-selected={sidebarVisible && sidebarView === 'debug'}
      >
        <Codicon name="debug-alt" />
        {status !== 'inactive' && status !== 'error' ? <span className="activitybar-running" /> : null}
      </button>

      <div className="activitybar-spacer" />

      <button className="activitybar-item" onClick={openCommandPalette} title="Manage (Command Palette)">
        <Codicon name="gear" />
      </button>
    </div>
  );
}
