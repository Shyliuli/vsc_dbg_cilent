import type { ReactNode } from 'react';

import { useDebugStore } from '../debug/store.ts';
import type { EditorTab } from '../debug/types.ts';
import { Breadcrumbs } from './Breadcrumbs.tsx';
import { DebugToolbar } from './DebugToolbar.tsx';
import { DisassemblyView } from './DisassemblyView.tsx';
import { LaunchJsonEditor } from './LaunchJsonEditor.tsx';
import { MemoryView } from './MemoryView.tsx';
import { Panel } from './Panel.tsx';
import { SourceEditor } from './SourceEditor.tsx';
import { Tabs } from './Tabs.tsx';
import { WelcomeView } from './WelcomeView.tsx';

function renderTab(tab: EditorTab | undefined): ReactNode {
  if (!tab || tab.kind === 'welcome') {
    return <WelcomeView />;
  }
  switch (tab.kind) {
    case 'source':
      return <SourceEditor tab={tab} />;
    case 'launch':
      return <LaunchJsonEditor tab={tab} />;
    case 'disassembly':
      return <DisassemblyView tab={tab} />;
    case 'memory':
      return <MemoryView tab={tab} />;
    default:
      return <WelcomeView />;
  }
}

export function EditorArea(): ReactNode {
  const activeTab = useDebugStore((state) => state.editorTabs.find((tab) => tab.id === state.activeTabId));
  const panelVisible = useDebugStore((state) => state.panelVisible);

  return (
    <div className="editor-area">
      <Tabs />
      <Breadcrumbs tab={activeTab} />
      <div className="editor-region">
        <DebugToolbar />
        <div className="editor-content">{renderTab(activeTab)}</div>
        {panelVisible ? <Panel /> : null}
      </div>
    </div>
  );
}
