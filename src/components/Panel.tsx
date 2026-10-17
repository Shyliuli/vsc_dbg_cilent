import { useEffect, useRef, useState, type ReactNode } from 'react';

import { useDebugStore } from '../debug/store.ts';
import { DebugConsole } from './panel/DebugConsole.tsx';
import { OutputView } from './panel/OutputView.tsx';
import { ProblemsView } from './panel/ProblemsView.tsx';
import { TerminalView } from './panel/TerminalView.tsx';
import { Codicon } from './Icons.tsx';

export function Panel(): ReactNode {
  const height = useDebugStore((state) => state.panelHeight);
  const panelTab = useDebugStore((state) => state.panelTab);
  const launchErrors = useDebugStore((state) => state.launchFile?.errors.length ?? 0);
  const setPanelTab = useDebugStore((state) => state.setPanelTab);
  const setPanelHeight = useDebugStore((state) => state.setPanelHeight);
  const togglePanel = useDebugStore((state) => state.togglePanel);
  const clearConsole = useDebugStore((state) => state.clearConsole);
  const clearOutput = useDebugStore((state) => state.clearOutput);
  const clearTerminal = useDebugStore((state) => state.clearTerminal);
  const showDapTrace = useDebugStore((state) => state.showDapTrace);
  const consoleCount = useDebugStore((state) => state.consoleLines.length);

  const [maximized, setMaximized] = useState(false);
  const restoreHeight = useRef(height);

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = height;
    const onMove = (moveEvent: PointerEvent) => {
      setPanelHeight(startHeight - (moveEvent.clientY - startY));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.classList.remove('resizing-vertical');
    };
    document.body.classList.add('resizing-vertical');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  useEffect(() => {
    if (maximized) {
      restoreHeight.current = height;
      setPanelHeight(Math.round(window.innerHeight * 0.62));
    } else if (restoreHeight.current !== height) {
      setPanelHeight(restoreHeight.current);
    }
    // Only react to the maximize toggle.
  }, [maximized]);

  const effectiveHeight = maximized ? Math.round(window.innerHeight * 0.62) : height;

  return (
    <div className="panel" style={{ height: effectiveHeight }}>
      <div className="panel-resizer" onPointerDown={startResize} />
      <div className="panel-header">
        <div className="panel-tabs" role="tablist">
          <button
            className={`panel-tab${panelTab === 'problems' ? ' active' : ''}`}
            onClick={() => setPanelTab('problems')}
            role="tab"
            aria-selected={panelTab === 'problems'}
          >
            Problems{launchErrors > 0 ? <span className="panel-badge">{launchErrors}</span> : null}
          </button>
          <button
            className={`panel-tab${panelTab === 'output' ? ' active' : ''}`}
            onClick={() => setPanelTab('output')}
            role="tab"
            aria-selected={panelTab === 'output'}
          >
            Output
          </button>
          <button
            className={`panel-tab${panelTab === 'debugConsole' ? ' active' : ''}`}
            onClick={() => setPanelTab('debugConsole')}
            role="tab"
            aria-selected={panelTab === 'debugConsole'}
          >
            Debug Console
            {consoleCount > 0 ? <span className="panel-badge subtle">{consoleCount}</span> : null}
          </button>
          <button
            className={`panel-tab${panelTab === 'terminal' ? ' active' : ''}`}
            onClick={() => setPanelTab('terminal')}
            role="tab"
            aria-selected={panelTab === 'terminal'}
          >
            Terminal
          </button>
        </div>
        <div className="panel-actions">
          <button
            title="Show DAP Trace in Output"
            onClick={() => void showDapTrace()}
          >
            <Codicon name="list-flat" />
          </button>
          <button
            title={
              panelTab === 'debugConsole'
                ? 'Clear Debug Console'
                : panelTab === 'output'
                  ? 'Clear Output'
                  : panelTab === 'terminal'
                    ? 'Clear Terminal'
                    : 'Clear Problems'
            }
            onClick={
              panelTab === 'debugConsole'
                ? clearConsole
                : panelTab === 'terminal'
                  ? clearTerminal
                  : clearOutput
            }
            disabled={panelTab === 'problems'}
          >
            <Codicon name="clear-all" />
          </button>
          <button title="Maximize Panel Size" onClick={() => setMaximized((value) => !value)}>
            <Codicon name={maximized ? 'chevron-down' : 'chevron-up'} />
          </button>
          <button title="Close Panel (Ctrl+`)" onClick={() => togglePanel()}>
            <Codicon name="close" />
          </button>
        </div>
      </div>
      <div className="panel-content">
        {panelTab === 'problems' ? <ProblemsView /> : null}
        {panelTab === 'output' ? <OutputView /> : null}
        {panelTab === 'debugConsole' ? <DebugConsole /> : null}
        {panelTab === 'terminal' ? <TerminalView /> : null}
      </div>
    </div>
  );
}
