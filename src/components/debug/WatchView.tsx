import type { ReactNode } from 'react';

import { useDebugStore } from '../../debug/store.ts';
import type { WatchItem } from '../../debug/types.ts';
import { Codicon } from '../Icons.tsx';
import { VariableRow } from './VariablesTree.tsx';

function WatchRow(props: { item: WatchItem }): ReactNode {
  const { item } = props;
  const expanded = useDebugStore(
    (state) => item.variablesReference !== undefined && state.expandedRefs[String(item.variablesReference)] === true,
  );
  const page = useDebugStore((state) =>
    item.variablesReference !== undefined ? state.variables[String(item.variablesReference)] : undefined,
  );
  const toggleVariableExpanded = useDebugStore((state) => state.toggleVariableExpanded);
  const loadMoreVariables = useDebugStore((state) => state.loadMoreVariables);
  const removeWatch = useDebugStore((state) => state.removeWatch);
  const editWatch = useDebugStore((state) => state.editWatch);
  const setContextMenu = useDebugStore((state) => state.setContextMenu);
  const addDataBreakpoint = useDebugStore((state) => state.addDataBreakpoint);
  const paused = useDebugStore((state) => state.status === 'stopped');

  const expandable = (item.variablesReference ?? 0) > 0;

  return (
    <div className="tree-node">
      <div
        className="tree-row watch-row"
        onDoubleClick={() => void editWatch(item.id)}
        onContextMenu={(event) => {
          event.preventDefault();
          setContextMenu({
            x: event.clientX,
            y: event.clientY,
            items: [
              { label: 'Edit Expression', action: () => void editWatch(item.id) },
              {
                label: 'Copy Value',
                disabled: item.value === undefined,
                action: () => void navigator.clipboard.writeText(item.value ?? ''),
              },
              { separator: true },
              {
                label: 'Break on Value Change',
                disabled: !paused,
                action: () => void addDataBreakpoint(item.expression, 'write'),
              },
              {
                label: 'Break on Value Read',
                disabled: !paused,
                action: () => void addDataBreakpoint(item.expression, 'read'),
              },
              {
                label: 'Break on Value Read/Write',
                disabled: !paused,
                action: () => void addDataBreakpoint(item.expression, 'readWrite'),
              },
              { separator: true },
              { label: 'Remove Watch', action: () => removeWatch(item.id) },
            ],
          });
        }}
      >
        {expandable ? (
          <button
            className="tree-twisty"
            onClick={() => void toggleVariableExpanded(item.variablesReference as number)}
          >
            <Codicon name={expanded ? 'chevron-down' : 'chevron-right'} />
          </button>
        ) : (
          <span className="tree-twisty-placeholder" />
        )}
        <span className="watch-expression" title={item.expression}>
          {item.expression}
        </span>
        {item.evaluating ? (
          <span className="watch-status">
            <Codicon name="loading" spin />
          </span>
        ) : item.error ? (
          <span className="watch-error" title={item.error}>
            {item.error}
          </span>
        ) : item.value === undefined ? (
          <span className="watch-status">not available</span>
        ) : (
          <>
            <span className="watch-value">
              {item.value || (item.variablesReference ? '{…}' : ' ')}
            </span>
            {item.type ? <span className="variable-type">{item.type}</span> : null}
          </>
        )}
        <span className="row-actions">
          <button title="Edit Expression" onClick={() => void editWatch(item.id)}>
            <Codicon name="edit" />
          </button>
          <button title="Remove Watch" onClick={() => removeWatch(item.id)}>
            <Codicon name="close" />
          </button>
        </span>
      </div>
      {expandable && expanded ? (
        <div className="tree-children">
          {page?.error ? <div className="tree-error" style={{ paddingLeft: 30 }}>{page.error}</div> : null}
          {page?.loading ? (
            <div className="tree-loading" style={{ paddingLeft: 30 }}>
              <Codicon name="loading" spin /> Loading…
            </div>
          ) : null}
          {(page?.nodes ?? []).map((node) => (
            <VariableRow key={node.key} node={node} depth={1} />
          ))}
          {page?.hasMore ? (
            <button
              className="tree-more"
              style={{ paddingLeft: 30 }}
              onClick={() => void loadMoreVariables(item.variablesReference as number)}
            >
              Load more…
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function WatchView(): ReactNode {
  const watches = useDebugStore((state) => state.watches);
  const addWatch = useDebugStore((state) => state.addWatch);

  if (watches.length === 0) {
    return (
      <div className="tree-empty">
        To add an expression, press <button className="link" onClick={() => void addWatch()}>Add Expression</button>.
      </div>
    );
  }

  return (
    <div className="tree">
      {watches.map((item) => (
        <WatchRow key={item.id} item={item} />
      ))}
    </div>
  );
}
