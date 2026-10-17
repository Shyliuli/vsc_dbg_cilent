import { useState, type ReactNode } from 'react';

import { useDebugStore } from '../../debug/store.ts';
import type { VariableNode } from '../../debug/types.ts';
import { Codicon } from '../Icons.tsx';

interface VariablesTreeProps {
  scopes: { name: string; hint?: string; variablesReference: number }[];
}

function useVariablePage(ref: number) {
  return useDebugStore((state) => state.variables[String(ref)]);
}

export function VariableRow(props: { node: VariableNode; depth: number }): ReactNode {
  const { node, depth } = props;
  const expanded = useDebugStore(
    (state) => state.expandedRefs[String(node.variablesReference)] === true,
  );
  const toggleVariableExpanded = useDebugStore((state) => state.toggleVariableExpanded);
  const loadMoreVariables = useDebugStore((state) => state.loadMoreVariables);
  const setVariableValue = useDebugStore((state) => state.setVariableValue);
  const addWatchForVariable = useDebugStore((state) => state.addWatchForVariable);
  const openMemoryView = useDebugStore((state) => state.openMemoryView);
  const setContextMenu = useDebugStore((state) => state.setContextMenu);
  const addDataBreakpoint = useDebugStore((state) => state.addDataBreakpoint);
  const paused = useDebugStore((state) => state.status === 'stopped');
  const [editing, setEditing] = useState<string | null>(null);

  const expandable = node.variablesReference > 0;
  const childPage = useVariablePage(node.variablesReference);

  const valueText =
    node.value || (node.variablesReference > 0 ? (node.indexedVariables ? '[…]' : '{…}') : ' ');

  const commit = () => {
    if (editing !== null) {
      const nextValue = editing;
      setEditing(null);
      void setVariableValue(node, nextValue);
    }
  };

  const copyValue = () => {
    void navigator.clipboard.writeText(node.value);
  };

  return (
    <div className="tree-node">
      <div
        className="tree-row variable-row"
        style={{ paddingLeft: 8 + depth * 12 }}
        onDoubleClick={() => setEditing(node.value)}
        onContextMenu={(event) => {
          event.preventDefault();
          setContextMenu({
            x: event.clientX,
            y: event.clientY,
            items: [
              { label: 'Set Value', action: () => setEditing(node.value) },
              { label: 'Copy Value', action: copyValue },
              { label: 'Copy as Expression', action: () => void navigator.clipboard.writeText(node.expression) },
              { label: 'Add to Watch', action: () => addWatchForVariable(node) },
              { separator: true },
              {
                label: 'Break on Value Change',
                disabled: !paused,
                action: () => void addDataBreakpoint(node.expression, 'write'),
              },
              {
                label: 'Break on Value Read',
                disabled: !paused,
                action: () => void addDataBreakpoint(node.expression, 'read'),
              },
              {
                label: 'Break on Value Read/Write',
                disabled: !paused,
                action: () => void addDataBreakpoint(node.expression, 'readWrite'),
              },
              { separator: true },
              ...(node.memoryReference
                ? [
                    {
                      label: 'View Memory',
                      action: () => void openMemoryView({ address: node.memoryReference, label: node.expression }),
                    },
                  ]
                : []),
            ],
          });
        }}
        title={`${node.expression}: ${node.type ?? 'value'}`}
      >
        {expandable ? (
          <button
            className="tree-twisty"
            onClick={(event) => {
              event.stopPropagation();
              void toggleVariableExpanded(node.variablesReference);
            }}
            title={expanded ? 'Collapse' : 'Expand'}
          >
            <Codicon name={expanded ? 'chevron-down' : 'chevron-right'} />
          </button>
        ) : (
          <span className="tree-twisty-placeholder" />
        )}
        <span className="variable-name">{node.name}</span>
        {editing !== null ? (
          <input
            className="inline-input variable-edit"
            aria-label={`Set value for ${node.name}`}
            autoFocus
            value={editing}
            onChange={(event) => setEditing(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                commit();
              } else if (event.key === 'Escape') {
                setEditing(null);
              }
            }}
            onBlur={commit}
            spellCheck={false}
          />
        ) : (
          <>
            <span className="variable-value">{valueText}</span>
            {node.type ? <span className="variable-type">{node.type}</span> : null}
          </>
        )}
        <span className="row-actions">
          <button title="Add to Watch" onClick={() => addWatchForVariable(node)}>
            <Codicon name="eye" />
          </button>
          <button title="Copy Value" onClick={copyValue}>
            <Codicon name="copy" />
          </button>
          <button title="Set Value" onClick={() => setEditing(node.value)}>
            <Codicon name="edit" />
          </button>
          {node.memoryReference ? (
            <button
              title="View Memory"
              onClick={() => void openMemoryView({ address: node.memoryReference, label: node.expression })}
            >
              <Codicon name="chip" />
            </button>
          ) : null}
        </span>
      </div>
      {expandable && expanded ? (
        <div className="tree-children">
          {childPage?.error ? (
            <div className="tree-error" style={{ paddingLeft: 30 + depth * 12 }}>{childPage.error}</div>
          ) : null}
          {childPage?.loading ? (
            <div className="tree-loading" style={{ paddingLeft: 30 + depth * 12 }}>
              <Codicon name="loading" spin /> Loading…
            </div>
          ) : null}
          {(childPage?.nodes ?? []).map((child) => (
            <VariableRow key={child.key} node={child} depth={depth + 1} />
          ))}
          {childPage?.hasMore ? (
            <button
              className="tree-more"
              style={{ paddingLeft: 30 + depth * 12 }}
              onClick={() => void loadMoreVariables(node.variablesReference)}
            >
              Load more…
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function VariablesTree(props: VariablesTreeProps): ReactNode {
  const status = useDebugStore((state) => state.status);
  const expandedRefs = useDebugStore((state) => state.expandedRefs);
  const variables = useDebugStore((state) => state.variables);
  const toggleVariableExpanded = useDebugStore((state) => state.toggleVariableExpanded);
  const loadMoreVariables = useDebugStore((state) => state.loadMoreVariables);

  if (status !== 'stopped') {
    return (
      <div className="tree-empty">
        {status === 'terminated' ? 'The debug session has terminated.' : 'Variables are not available while the program is running.'}
      </div>
    );
  }

  if (props.scopes.length === 0) {
    return <div className="tree-empty">No variables in the selected frame.</div>;
  }

  return (
    <div className="tree">
      {props.scopes.map((scope) => {
        const key = String(scope.variablesReference);
        const expanded = expandedRefs[key] === true;
        const page = variables[key];
        return (
          <div key={`${scope.name}-${scope.variablesReference}`} className="tree-node">
            <div
              className="tree-row scope-row"
              onClick={() => void toggleVariableExpanded(scope.variablesReference)}
            >
              <button
                className="tree-twisty"
                onClick={(event) => {
                  event.stopPropagation();
                  void toggleVariableExpanded(scope.variablesReference);
                }}
              >
                <Codicon name={expanded ? 'chevron-down' : 'chevron-right'} />
              </button>
              <span className="scope-name">{scope.name}</span>
            </div>
            {expanded ? (
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
                    onClick={() => void loadMoreVariables(scope.variablesReference)}
                  >
                    Load more…
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
