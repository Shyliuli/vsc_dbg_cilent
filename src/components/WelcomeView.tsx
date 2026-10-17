import type { ReactNode } from 'react';

import { runCommand } from '../commands.ts';
import { basename } from '../debug/format.ts';
import { useDebugStore } from '../debug/store.ts';
import { openCommandPalette } from '../ui/events.ts';
import { Codicon } from './Icons.tsx';

const SHORTCUTS: Array<[string, string]> = [
  ['F5', 'Start / Continue'],
  ['Shift+F5', 'Stop'],
  ['Ctrl+Shift+F5', 'Restart'],
  ['F9', 'Toggle breakpoint'],
  ['F10 / F11', 'Step over / into'],
  ['Shift+F11', 'Step out'],
  ['Ctrl+F10', 'Run to cursor'],
  ['Ctrl+Shift+P', 'Command palette'],
  ['Ctrl+Shift+D', 'Run and Debug view'],
  ['Ctrl+`', 'Toggle panel'],
];

export function WelcomeView(): ReactNode {
  const workspace = useDebugStore((state) => state.workspace);
  const environment = useDebugStore((state) => state.environment);
  const launchFile = useDebugStore((state) => state.launchFile);
  const startDebugging = useDebugStore((state) => state.startDebugging);
  const openLaunchJson = useDebugStore((state) => state.openLaunchJson);
  const selectConfig = useDebugStore((state) => state.selectConfig);

  const configs = launchFile?.configs ?? [];

  const start = () => {
    if (configs.length === 0) {
      void openLaunchJson();
      return;
    }
    void startDebugging(configs[0]?.name);
  };

  return (
    <div className="welcome">
      <div className="welcome-hero">
        <Codicon name="debug-alt" className="welcome-logo" />
        <div>
          <h1>gdb-client</h1>
          <p className="welcome-subtitle">
            Debug C and C++ with gdb through the Debug Adapter Protocol, in a VS Code-style
            workbench.
          </p>
        </div>
      </div>

      <div className="welcome-columns">
        <section className="welcome-section">
          <h2>Start</h2>
          <button className="welcome-primary" onClick={start}>
            <Codicon name="play" />
            <span>Run and Debug</span>
          </button>
          <button className="welcome-link" onClick={() => void openLaunchJson()}>
            <Codicon name="gear" />
            <span>Open launch.json</span>
          </button>
          <button className="welcome-link" onClick={openCommandPalette}>
            <Codicon name="search" />
            <span>Show All Commands</span>
            <span className="welcome-keybinding">Ctrl+Shift+P</span>
          </button>
          <button className="welcome-link" onClick={() => runCommand('debug.openDisassembly')}>
            <Codicon name="debug-line-by-line" />
            <span>Open Disassembly View</span>
          </button>
          <button className="welcome-link" onClick={() => runCommand('help.shortcuts')}>
            <Codicon name="keyboard" />
            <span>Keyboard Shortcuts</span>
          </button>
        </section>

        <section className="welcome-section">
          <h2>Configurations</h2>
          {configs.length === 0 ? (
            <p className="welcome-hint">
              No launch configurations yet.{' '}
              <button className="link" onClick={() => void openLaunchJson()}>
                Create launch.json
              </button>{' '}
              to describe how your program should start.
            </p>
          ) : (
            configs.map((config) => (
              <button
                key={`${config.name}-${config.index}`}
                className="welcome-recent"
                onClick={() => {
                  selectConfig(config.name);
                  void startDebugging(config.name);
                }}
                title={config.warnings.join('\n') || undefined}
              >
                <Codicon name={config.request === 'attach' ? 'debug-alt' : 'play'} />
                <span className="welcome-recent-name">{config.name}</span>
                <span className="welcome-recent-detail">
                  {config.request} ·{' '}
                  {config.program ? basename(config.program) : config.target ?? 'pick a process'}
                </span>
              </button>
            ))
          )}
        </section>

        <section className="welcome-section">
          <h2>Keyboard Shortcuts</h2>
          <div className="welcome-shortcuts">
            {SHORTCUTS.map(([keys, label]) => (
              <div key={keys} className="welcome-shortcut">
                <span className="welcome-keybinding">{keys}</span>
                <span>{label}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="welcome-section">
          <h2>Environment</h2>
          <div className="welcome-info">
            <div>
              <span className="welcome-info-label">Workspace</span>
              <span className="welcome-info-value">{workspace?.root ?? 'not connected'}</span>
            </div>
            <div>
              <span className="welcome-info-label">Debug adapter</span>
              <span className="welcome-info-value">
                {environment?.available ? environment.version : 'gdb not found on PATH'}
              </span>
            </div>
            <div>
              <span className="welcome-info-label">Protocol</span>
              <span className="welcome-info-value">Debug Adapter Protocol over gdb --interpreter=dap</span>
            </div>
            <div>
              <span className="welcome-info-label">launch.json</span>
              <span className="welcome-info-value">
                {launchFile?.exists ? launchFile.relativePath : 'not created yet'}
              </span>
            </div>
          </div>
        </section>
      </div>

      <div className="welcome-footer">
        The debugger is implemented as a browser DAP client; gdb is the adapter.
      </div>
    </div>
  );
}
