import type { ReactNode } from 'react';

import { useDebugStore } from '../../debug/store.ts';
import { Codicon } from '../Icons.tsx';
import { Section } from '../Section.tsx';
import { BreakpointsView } from './BreakpointsView.tsx';
import { CallStackView } from './CallStackView.tsx';
import { VariablesTree } from './VariablesTree.tsx';
import { WatchView } from './WatchView.tsx';

export function DebugView(): ReactNode {
  const status = useDebugStore((state) => state.status);
  const selectedConfigName = useDebugStore((state) => state.selectedConfigName);
  const launchFile = useDebugStore((state) => state.launchFile);
  const activeConfig = useDebugStore((state) => state.activeConfig);
  const scopes = useDebugStore((state) => state.scopes);
  const watches = useDebugStore((state) => state.watches);
  const breakpoints = useDebugStore((state) => state.breakpoints);
  const functionBreakpoints = useDebugStore((state) => state.functionBreakpoints);
  const instructionBreakpoints = useDebugStore((state) => state.instructionBreakpoints);
  const dataBreakpoints = useDebugStore((state) => state.dataBreakpoints);
  const startDebugging = useDebugStore((state) => state.startDebugging);
  const stopDebugging = useDebugStore((state) => state.stopDebugging);
  const restartDebugging = useDebugStore((state) => state.restartDebugging);
  const pauseExecution = useDebugStore((state) => state.pauseExecution);
  const selectConfig = useDebugStore((state) => state.selectConfig);
  const openLaunchJson = useDebugStore((state) => state.openLaunchJson);
  const refreshScopes = useDebugStore((state) => state.refreshScopes);
  const addWatch = useDebugStore((state) => state.addWatch);
  const removeWatch = useDebugStore((state) => state.removeWatch);
  const setContextMenu = useDebugStore((state) => state.setContextMenu);
  const removeAllBreakpoints = useDebugStore((state) => state.removeAllBreakpoints);
  const setAllBreakpointsEnabled = useDebugStore((state) => state.setAllBreakpointsEnabled);
  const addFunctionBreakpoint = useDebugStore((state) => state.addFunctionBreakpoint);
  const promptAddDataBreakpoint = useDebugStore((state) => state.promptAddDataBreakpoint);
  const removeAllDataBreakpoints = useDebugStore((state) => state.removeAllDataBreakpoints);

  const configs = launchFile?.configs ?? [];
  const sessionActive = status !== 'inactive' && status !== 'error';
  const breakpointCount =
    Object.values(breakpoints).flat().filter((breakpoint) => !breakpoint.temporary).length +
    functionBreakpoints.length +
    instructionBreakpoints.length +
    dataBreakpoints.length;

  const start = () => {
    if (configs.length === 0) {
      void openLaunchJson();
      return;
    }
    void startDebugging(selectedConfigName ?? undefined);
  };

  const breakpointMenu = (x: number, y: number) => {
    setContextMenu({
      x,
      y,
      items: [
        { label: 'Add Function Breakpoint', action: () => void addFunctionBreakpoint() },
        { label: 'Add Data Breakpoint…', action: () => void promptAddDataBreakpoint() },
        { separator: true },
        { label: 'Enable All Breakpoints', action: () => void setAllBreakpointsEnabled(true) },
        { label: 'Disable All Breakpoints', action: () => void setAllBreakpointsEnabled(false) },
        { label: 'Remove All Breakpoints', action: () => void removeAllBreakpoints() },
        {
          label: 'Remove All Data Breakpoints',
          action: () => void removeAllDataBreakpoints(),
        },
      ],
    });
  };

  return (
    <div className="debug-view">
      {sessionActive && activeConfig ? (
        <div className="debug-session-bar">
          <Codicon name={status === 'stopped' ? 'debug-pause' : 'debug-alt'} />
          <span className="debug-session-name" title={activeConfig.name}>
            {activeConfig.name}
          </span>
          <span className="debug-session-actions">
            <button title="Restart (Ctrl+Shift+F5)" onClick={() => void restartDebugging()}>
              <Codicon name="debug-restart" />
            </button>
            <button title="Stop (Shift+F5)" onClick={() => void stopDebugging()}>
              <Codicon name="debug-stop" />
            </button>
          </span>
        </div>
      ) : (
        <div className="debug-start">
          {configs.length > 0 ? (
            <div className="debug-config-row">
              <select
                id="launch-config-select"
                name="launch-config-select"
                aria-label="Launch configuration"
                className="config-select"
                value={selectedConfigName ?? configs[0]?.name ?? ''}
                onChange={(event) => selectConfig(event.target.value)}
                title="Select launch configuration"
              >
                {configs.map((config) => (
                  <option key={`${config.name}-${config.index}`} value={config.name}>
                    {config.name}
                  </option>
                ))}
              </select>
              <button title="Open launch.json" onClick={() => void openLaunchJson()}>
                <Codicon name="gear" />
              </button>
              <button className="debug-start-button" title="Start Debugging (F5)" onClick={start}>
                <Codicon name="play" />
              </button>
            </div>
          ) : (
            <button className="debug-start-hero" onClick={start} title="Create launch.json to start debugging">
              <Codicon name="play" />
              <span>Run and Debug</span>
            </button>
          )}
          <div className="debug-start-hint">
            {launchFile?.exists ? (
              'Select a configuration and press F5 to start debugging.'
            ) : (
              <>
                To customize Run and Debug,{' '}
                <button className="link" onClick={() => void openLaunchJson()}>
                  create a launch.json file
                </button>
                .
              </>
            )}
          </div>
          {(launchFile?.errors.length ?? 0) > 0 ? (
            <div className="debug-error-box">
              <div className="debug-error-title">
                <Codicon name="error" /> launch.json has errors
              </div>
              {launchFile?.errors.map((error) => (
                <div key={error} className="debug-error-line">
                  {error}
                </div>
              ))}
              <button className="link" onClick={() => void openLaunchJson()}>
                Open launch.json
              </button>
            </div>
          ) : null}
        </div>
      )}

      <Section
        title="VARIABLES"
        actions={
          <>
            <button
              title="Refresh variables"
              disabled={status !== 'stopped'}
              onClick={() => void refreshScopes()}
            >
              <Codicon name="refresh" />
            </button>
          </>
        }
      >
        <VariablesTree scopes={scopes} />
      </Section>

      <Section
        title="WATCH"
        actions={
          <>
            <button title="Add Expression" onClick={() => void addWatch()}>
              <Codicon name="add" />
            </button>
            <button
              title="Remove All Watches"
              disabled={watches.length === 0}
              onClick={() => {
                for (const watch of watches) {
                  removeWatch(watch.id);
                }
              }}
            >
              <Codicon name="clear-all" />
            </button>
          </>
        }
      >
        <WatchView />
      </Section>

      <Section
        title="CALL STACK"
        actions={
          status === 'running' ? (
            <button title="Pause" onClick={pauseExecution}>
              <Codicon name="debug-pause" />
            </button>
          ) : null
        }
      >
        <CallStackView />
      </Section>

      <Section
        title="BREAKPOINTS"
        count={breakpointCount}
        actions={
          <>
            <button title="Add Function Breakpoint" onClick={() => void addFunctionBreakpoint()}>
              <Codicon name="add" />
            </button>
            <button
              title="More Actions…"
              onClick={(event) => {
                const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
                breakpointMenu(rect.right, rect.bottom + 2);
              }}
            >
              <Codicon name="ellipsis" />
            </button>
          </>
        }
      >
        <BreakpointsView />
      </Section>
    </div>
  );
}
