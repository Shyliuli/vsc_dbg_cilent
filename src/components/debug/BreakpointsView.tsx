import type { ReactNode } from 'react';

import { basename, breakpointDetail, breakpointIcon } from '../../debug/format.ts';
import { watchpointAccessLabel } from '../../../shared/watchpoints.ts';
import { useDebugStore } from '../../debug/store.ts';
import type { DataBreakpoint, SourceBreakpoint } from '../../debug/types.ts';
import { Codicon } from '../Icons.tsx';

function SourceBreakpointRow(props: { breakpoint: SourceBreakpoint }): ReactNode {
  const { breakpoint } = props;
  const setBreakpointEnabled = useDebugStore((state) => state.setBreakpointEnabled);
  const removeBreakpoint = useDebugStore((state) => state.removeBreakpoint);
  const editBreakpointCondition = useDebugStore((state) => state.editBreakpointCondition);
  const editBreakpointHitCount = useDebugStore((state) => state.editBreakpointHitCount);
  const editBreakpointLogMessage = useDebugStore((state) => state.editBreakpointLogMessage);
  const openSource = useDebugStore((state) => state.openSource);
  const setContextMenu = useDebugStore((state) => state.setContextMenu);

  const detail = breakpointDetail(breakpoint);
  const iconState = !breakpoint.enabled
    ? 'disabled'
    : !breakpoint.verified
      ? 'unverified'
      : breakpoint.logMessage
        ? 'log'
        : breakpoint.condition
          ? 'conditional'
          : 'default';

  return (
    <div
      className={`tree-row breakpoint-row${breakpoint.enabled ? '' : ' disabled'}`}
      title={breakpoint.message ?? `${breakpoint.path}:${breakpoint.line}`}
      onContextMenu={(event) => {
        event.preventDefault();
        setContextMenu({
          x: event.clientX,
          y: event.clientY,
          items: [
            { label: 'Edit Condition', action: () => void editBreakpointCondition(breakpoint.id) },
            { label: 'Edit Hit Count', action: () => void editBreakpointHitCount(breakpoint.id) },
            { label: 'Edit Log Message', action: () => void editBreakpointLogMessage(breakpoint.id) },
            { separator: true },
            {
              label: breakpoint.enabled ? 'Disable Breakpoint' : 'Enable Breakpoint',
              action: () => void setBreakpointEnabled(breakpoint.id, !breakpoint.enabled),
            },
            {
              label: 'Remove Breakpoint',
              action: () => void removeBreakpoint(breakpoint.id),
            },
          ],
        });
      }}
    >
      <input
        type="checkbox"
        id={`source-breakpoint-enabled-${breakpoint.id}`}
        name="source-breakpoint-enabled"
        aria-label={`${breakpoint.enabled ? 'Disable' : 'Enable'} breakpoint ${basename(breakpoint.path)}:${breakpoint.line}`}
        checked={breakpoint.enabled}
        onChange={(event) => void setBreakpointEnabled(breakpoint.id, event.target.checked)}
        title={breakpoint.enabled ? 'Disable Breakpoint' : 'Enable Breakpoint'}
      />
      <Codicon name={breakpointIcon(breakpoint)} className={`breakpoint-icon ${iconState}`} />
      <button
        className="breakpoint-label"
        onClick={() => void openSource(breakpoint.path, breakpoint.line, { pinned: true })}
        title={breakpoint.path}
      >
        {basename(breakpoint.path)}:{breakpoint.line}
      </button>
      {detail ? <span className="breakpoint-detail">{detail}</span> : null}
      {!breakpoint.verified && breakpoint.message ? (
        <Codicon name="warning" className="breakpoint-warning" title={breakpoint.message} />
      ) : null}
      <span className="row-actions">
        <button
          title={breakpoint.logMessage ? 'Edit Log Message' : 'Edit Condition'}
          onClick={() =>
            breakpoint.logMessage
              ? void editBreakpointLogMessage(breakpoint.id)
              : void editBreakpointCondition(breakpoint.id)
          }
        >
          <Codicon name="edit" />
        </button>
        <button title="Remove Breakpoint" onClick={() => void removeBreakpoint(breakpoint.id)}>
          <Codicon name="close" />
        </button>
      </span>
    </div>
  );
}

function DataBreakpointRow(props: { breakpoint: DataBreakpoint }): ReactNode {
  const { breakpoint } = props;
  const paused = useDebugStore((state) => state.status === 'stopped');
  const hit = useDebugStore((state) => state.hitDataBreakpointId === breakpoint.id);
  const setDataBreakpointEnabled = useDebugStore((state) => state.setDataBreakpointEnabled);
  const removeDataBreakpoint = useDebugStore((state) => state.removeDataBreakpoint);
  const setContextMenu = useDebugStore((state) => state.setContextMenu);
  const openSource = useDebugStore((state) => state.openSource);

  const toggle = () => {
    if (!paused) {
      useDebugStore.getState().notify({
        severity: 'warning',
        message: 'Pause the program to enable or disable data breakpoints.',
      });
      return;
    }
    void setDataBreakpointEnabled(breakpoint.id, !breakpoint.enabled);
  };

  return (
    <div
      className={`tree-row breakpoint-row${breakpoint.enabled ? '' : ' disabled'}${hit ? ' hit' : ''}`}
      title={
        breakpoint.message ??
        `${watchpointAccessLabel(breakpoint.access)} watchpoint on ${breakpoint.expression}${
          breakpoint.adapterId !== undefined ? ` (gdb #${breakpoint.adapterId})` : ''
        }`
      }
      onContextMenu={(event) => {
        event.preventDefault();
        setContextMenu({
          x: event.clientX,
          y: event.clientY,
          items: [
            {
              label: breakpoint.enabled ? 'Disable Data Breakpoint' : 'Enable Data Breakpoint',
              action: toggle,
            },
            {
              label: 'Copy Expression',
              action: () => void navigator.clipboard.writeText(breakpoint.expression),
            },
            ...(breakpoint.sourcePath
              ? [
                  {
                    label: 'Reveal in Source',
                    action: () =>
                      void openSource(
                        breakpoint.sourcePath as string,
                        breakpoint.line ?? 1,
                        { pinned: true },
                      ),
                  },
                ]
              : []),
            { separator: true },
            { label: 'Remove Data Breakpoint', action: () => void removeDataBreakpoint(breakpoint.id) },
          ],
        });
      }}
    >
      <input
        type="checkbox"
        id={`data-breakpoint-enabled-${breakpoint.id}`}
        name="data-breakpoint-enabled"
        aria-label={`${breakpoint.enabled ? 'Disable' : 'Enable'} data breakpoint ${breakpoint.expression}`}
        checked={breakpoint.enabled}
        onChange={toggle}
      />
      <Codicon name="debug-breakpoint-data" className="breakpoint-icon data" />
      <span className="breakpoint-label static">{breakpoint.expression}</span>
      <span className="breakpoint-detail">{watchpointAccessLabel(breakpoint.access)}</span>
      {!breakpoint.verified && breakpoint.message ? (
        <Codicon name="warning" className="breakpoint-warning" title={breakpoint.message} />
      ) : null}
      <span className="row-actions">
        <button title="Remove Data Breakpoint" onClick={() => void removeDataBreakpoint(breakpoint.id)}>
          <Codicon name="close" />
        </button>
      </span>
    </div>
  );
}

export function BreakpointsView(): ReactNode {
  const breakpoints = useDebugStore((state) => state.breakpoints);
  const functionBreakpoints = useDebugStore((state) => state.functionBreakpoints);
  const instructionBreakpoints = useDebugStore((state) => state.instructionBreakpoints);
  const dataBreakpoints = useDebugStore((state) => state.dataBreakpoints);
  const paused = useDebugStore((state) => state.status === 'stopped');
  const promptAddDataBreakpoint = useDebugStore((state) => state.promptAddDataBreakpoint);
  const exceptionFilters = useDebugStore((state) => state.exceptionFilters);
  const addFunctionBreakpoint = useDebugStore((state) => state.addFunctionBreakpoint);
  const removeFunctionBreakpoint = useDebugStore((state) => state.removeFunctionBreakpoint);
  const setFunctionBreakpointEnabled = useDebugStore((state) => state.setFunctionBreakpointEnabled);
  const editFunctionBreakpointCondition = useDebugStore((state) => state.editFunctionBreakpointCondition);
  const removeInstructionBreakpoint = useDebugStore((state) => state.removeInstructionBreakpoint);
  const setExceptionFilter = useDebugStore((state) => state.setExceptionFilter);
  const editExceptionCondition = useDebugStore((state) => state.editExceptionCondition);
  const setContextMenu = useDebugStore((state) => state.setContextMenu);
  const openSource = useDebugStore((state) => state.openSource);

  const sourceBreakpoints = Object.values(breakpoints)
    .flat()
    .filter((breakpoint) => !breakpoint.temporary)
    .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);

  const hasAny =
    sourceBreakpoints.length > 0 ||
    functionBreakpoints.length > 0 ||
    instructionBreakpoints.length > 0 ||
    dataBreakpoints.length > 0;

  return (
    <div className="breakpoints">
      {sourceBreakpoints.length === 0 && functionBreakpoints.length === 0 ? (
        <div className="tree-empty">
          Set a breakpoint by clicking the editor gutter or pressing F9.
        </div>
      ) : null}

      {sourceBreakpoints.map((breakpoint) => (
        <SourceBreakpointRow key={breakpoint.id} breakpoint={breakpoint} />
      ))}

      <div className="bp-subheader">
        <span>Data Breakpoints</span>
        <button
          title={paused ? 'Add Data Breakpoint' : 'Pause the program to add data breakpoints'}
          disabled={!paused}
          onClick={() => void promptAddDataBreakpoint()}
        >
          <Codicon name="add" />
        </button>
      </div>
      {dataBreakpoints.map((breakpoint) => (
        <DataBreakpointRow key={breakpoint.id} breakpoint={breakpoint} />
      ))}

      <div className="bp-subheader">
        <span>Function Breakpoints</span>
        <button title="Add Function Breakpoint" onClick={() => void addFunctionBreakpoint()}>
          <Codicon name="add" />
        </button>
      </div>
      {functionBreakpoints.map((breakpoint) => (
        <div
          key={breakpoint.id}
          className={`tree-row breakpoint-row${breakpoint.enabled ? '' : ' disabled'}`}
          onContextMenu={(event) => {
            event.preventDefault();
            setContextMenu({
              x: event.clientX,
              y: event.clientY,
              items: [
                {
                  label: 'Edit Condition',
                  action: () => void editFunctionBreakpointCondition(breakpoint.id),
                },
                {
                  label: breakpoint.enabled ? 'Disable Breakpoint' : 'Enable Breakpoint',
                  action: () => void setFunctionBreakpointEnabled(breakpoint.id, !breakpoint.enabled),
                },
                {
                  label: 'Remove Breakpoint',
                  action: () => void removeFunctionBreakpoint(breakpoint.id),
                },
              ],
            });
          }}
        >
          <input
            type="checkbox"
            id={`function-breakpoint-enabled-${breakpoint.id}`}
            name="function-breakpoint-enabled"
            aria-label={`${breakpoint.enabled ? 'Disable' : 'Enable'} function breakpoint ${breakpoint.name}`}
            checked={breakpoint.enabled}
            onChange={(event) => void setFunctionBreakpointEnabled(breakpoint.id, event.target.checked)}
          />
          <Codicon name="debug-breakpoint-function" className="breakpoint-icon function" />
          <span className="breakpoint-label static">{breakpoint.name}</span>
          {breakpoint.condition ? <span className="breakpoint-detail">condition: {breakpoint.condition}</span> : null}
          <span className="row-actions">
            <button
              title="Edit Condition"
              onClick={() => void editFunctionBreakpointCondition(breakpoint.id)}
            >
              <Codicon name="edit" />
            </button>
            <button title="Remove Breakpoint" onClick={() => void removeFunctionBreakpoint(breakpoint.id)}>
              <Codicon name="close" />
            </button>
          </span>
        </div>
      ))}

      {instructionBreakpoints.length > 0 ? (
        <div className="bp-subheader">
          <span>Instruction Breakpoints</span>
        </div>
      ) : null}
      {instructionBreakpoints.map((breakpoint) => (
        <div key={breakpoint.id} className="tree-row breakpoint-row">
          <span className="tree-twisty-placeholder" />
          <Codicon name="debug-breakpoint" className="breakpoint-icon default" />
          <button
            className="breakpoint-label"
            onClick={() =>
              breakpoint.sourcePath
                ? void openSource(breakpoint.sourcePath, breakpoint.line ?? 1, { pinned: true })
                : undefined
            }
            title={breakpoint.instructionReference}
          >
            {breakpoint.instructionReference}
            {breakpoint.sourcePath
              ? ` — ${basename(breakpoint.sourcePath)}:${breakpoint.line ?? '?'}`
              : ''}
          </button>
          <span className="row-actions">
            <button title="Remove Breakpoint" onClick={() => void removeInstructionBreakpoint(breakpoint.id)}>
              <Codicon name="close" />
            </button>
          </span>
        </div>
      ))}

      {exceptionFilters.length > 0 ? (
        <div className="bp-subheader">
          <span>Exception Breakpoints</span>
        </div>
      ) : null}
      {exceptionFilters.map((filter) => (
        <div key={filter.filter} className="tree-row breakpoint-row">
          <input
            type="checkbox"
            id={`exception-filter-enabled-${filter.filter}`}
            name="exception-filter-enabled"
            aria-label={`${filter.enabled ? 'Disable' : 'Enable'} exception filter ${filter.label}`}
            checked={filter.enabled}
            onChange={(event) => void setExceptionFilter(filter.filter, event.target.checked)}
          />
          <Codicon name="debug-breakpoint-conditional" className="breakpoint-icon exception" />
          <span className="breakpoint-label static">{filter.label}</span>
          {filter.condition ? <span className="breakpoint-detail">when: {filter.condition}</span> : null}
          <span className="row-actions">
            {filter.supportsCondition ? (
              <button
                title="Edit Condition"
                onClick={() => void editExceptionCondition(filter.filter)}
              >
                <Codicon name="edit" />
              </button>
            ) : null}
          </span>
        </div>
      ))}

      {!hasAny && exceptionFilters.length === 0 ? (
        <div className="tree-empty small">No breakpoints.</div>
      ) : null}
    </div>
  );
}
