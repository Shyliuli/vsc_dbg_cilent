import { Fragment, type ReactNode } from 'react';

import { basename } from '../debug/format.ts';
import { useDebugStore } from '../debug/store.ts';
import { Codicon, FileIcon, TabIcon } from './Icons.tsx';

export function ExplorerView(): ReactNode {
  const workspace = useDebugStore((state) => state.workspace);
  const entries = useDebugStore((state) => state.explorerEntries);
  const expanded = useDebugStore((state) => state.explorerExpanded);
  const loading = useDebugStore((state) => state.explorerLoading);
  const tabs = useDebugStore((state) => state.editorTabs);
  const activeTabId = useDebugStore((state) => state.activeTabId);
  const activateTab = useDebugStore((state) => state.activateTab);
  const closeTab = useDebugStore((state) => state.closeTab);
  const openSource = useDebugStore((state) => state.openSource);
  const toggleDirectory = useDebugStore((state) => state.toggleDirectory);

  const root = workspace?.root ?? '';
  const absoluteOf = (relative: string) => (root ? `${root}/${relative}` : relative);

  const renderDirectory = (directory: string, depth: number): ReactNode => {
    const list = entries[directory] ?? [];
    if (loading[directory] && list.length === 0) {
      return (
        <div className="tree-loading" style={{ paddingLeft: 16 + depth * 12 }}>
          <Codicon name="loading" spin /> Loading…
        </div>
      );
    }
    return list.map((entry) => {
      const isDirectory = entry.type === 'directory';
      const isExpanded = expanded[entry.path] === true;
      return (
        <Fragment key={entry.path}>
          <div
            className="tree-row explorer-row"
            style={{ paddingLeft: 8 + depth * 12 }}
            onClick={() => {
              if (isDirectory) {
                void toggleDirectory(entry.path);
              } else {
                void openSource(absoluteOf(entry.path));
              }
            }}
            title={entry.path}
          >
            {isDirectory ? (
              <Codicon name={isExpanded ? 'chevron-down' : 'chevron-right'} className="tree-twisty-icon" />
            ) : (
              <span className="tree-twisty-placeholder" />
            )}
            {isDirectory ? (
              <Codicon name={isExpanded ? 'folder-opened' : 'folder'} className="folder-icon" />
            ) : (
              <FileIcon path={entry.path} />
            )}
            <span className="explorer-name">{entry.name}</span>
          </div>
          {isDirectory && isExpanded ? renderDirectory(entry.path, depth + 1) : null}
        </Fragment>
      );
    });
  };

  return (
    <div className="explorer">
      <div className="explorer-group">
        <div className="explorer-group-header">
          <span>Open Editors</span>
        </div>
        {tabs.length === 0 ? (
          <div className="tree-empty small">No opened editors.</div>
        ) : (
          tabs.map((tab) => (
            <div
              key={tab.id}
              className={`tree-row editor-row${tab.id === activeTabId ? ' selected' : ''}`}
              onClick={() => activateTab(tab.id)}
              title={tab.path ?? tab.title}
            >
              <TabIcon kind={tab.kind} path={tab.path} />
              <span className="explorer-name">{tab.title}</span>
              {tab.dirty ? <span className="dirty-dot">●</span> : null}
              <span className="row-actions">
                <button
                  title="Close"
                  onClick={(event) => {
                    event.stopPropagation();
                    closeTab(tab.id);
                  }}
                >
                  <Codicon name="close" />
                </button>
              </span>
            </div>
          ))
        )}
      </div>

      <div className="explorer-group">
        <div
          className={`tree-row explorer-root${expanded[''] === false ? '' : ' expanded'}`}
          onClick={() => void toggleDirectory('')}
        >
          <Codicon name={expanded[''] === false ? 'chevron-right' : 'chevron-down'} className="tree-twisty-icon" />
          <Codicon name={expanded[''] === false ? 'folder' : 'folder-opened'} className="folder-icon" />
          <span className="explorer-name">{workspace?.name ?? (basename(root) || 'workspace')}</span>
        </div>
        {expanded[''] === false ? null : renderDirectory('', 1)}
      </div>
    </div>
  );
}
