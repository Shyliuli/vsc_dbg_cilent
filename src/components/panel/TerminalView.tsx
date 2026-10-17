import { useEffect, useRef, type ReactNode } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

import { useDebugStore } from '../../debug/store.ts';
import { Codicon } from '../Icons.tsx';

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

const TERMINAL_THEME = {
  background: '#1f1f1f',
  foreground: '#cccccc',
  cursor: '#aeafad',
  cursorAccent: '#1f1f1f',
  selectionBackground: '#264f78',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#e5e5e5',
};

function TerminalCanvas(): ReactNode {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const writtenRef = useRef(0);
  const epochRef = useRef(-1);
  const terminal = useDebugStore((state) => state.terminal);
  const sendTerminalInput = useDebugStore((state) => state.sendTerminalInput);
  const resizeTerminal = useDebugStore((state) => state.resizeTerminal);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const term = new Terminal({
      fontFamily: "'DejaVu Sans Mono', 'Droid Sans Mono', 'Liberation Mono', monospace",
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      theme: TERMINAL_THEME,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    termRef.current = term;
    const helperTextarea = container.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea');
    if (helperTextarea) {
      helperTextarea.id = 'terminal-input';
      helperTextarea.name = 'terminal-input';
      helperTextarea.setAttribute('aria-label', 'Terminal input');
    }

    const applySize = () => {
      try {
        fit.fit();
      } catch {
        // The panel can be hidden or zero-sized while it is being restored.
      }
      if (term.cols > 0 && term.rows > 0) {
        resizeTerminal(term.cols, term.rows);
      }
    };
    applySize();

    const dataDisposable = term.onData((data) => {
      sendTerminalInput(new TextEncoder().encode(data));
    });
    const observer = new ResizeObserver(() => applySize());
    observer.observe(container);
    term.focus();

    return () => {
      observer.disconnect();
      dataDisposable.dispose();
      term.dispose();
      termRef.current = null;
      writtenRef.current = 0;
      epochRef.current = -1;
    };
  }, [resizeTerminal, sendTerminalInput]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) {
      return;
    }
    if (terminal.epoch !== epochRef.current) {
      epochRef.current = terminal.epoch;
      writtenRef.current = 0;
      term.reset();
    }
    const fresh = terminal.chunks.slice(writtenRef.current);
    for (const chunk of fresh) {
      term.write(decodeBase64(chunk));
    }
    writtenRef.current = terminal.chunks.length;
  }, [terminal.chunks, terminal.epoch]);

  useEffect(() => {
    if (terminal.available) {
      termRef.current?.focus();
    }
  }, [terminal.available]);

  return (
    <div className="terminal-view">
      <div className="terminal-canvas" ref={containerRef} />
      {terminal.exited ? <div className="terminal-exit">Process exited — terminal is read-only.</div> : null}
    </div>
  );
}

function TerminalPlaceholder(): ReactNode {
  const status = useDebugStore((state) => state.status);
  const activeConfig = useDebugStore((state) => state.activeConfig);
  const terminal = useDebugStore((state) => state.terminal);
  const openLaunchJson = useDebugStore((state) => state.openLaunchJson);

  const sessionActive = status !== 'inactive' && status !== 'error' && status !== 'terminated';
  const usingInternalConsole = activeConfig?.console !== 'integratedTerminal';

  return (
    <div className="terminal-placeholder">
      <Codicon name="terminal" className="terminal-placeholder-icon" />
      <div className="terminal-placeholder-body">
        {terminal.error ? (
          <>
            <div className="terminal-placeholder-title">Integrated terminal failed</div>
            <div className="terminal-placeholder-text">{terminal.error}</div>
          </>
        ) : !sessionActive ? (
          <>
            <div className="terminal-placeholder-title">Integrated terminal</div>
            <div className="terminal-placeholder-text">
              Start a debug session whose configuration sets{' '}
              <code>&quot;console&quot;: &quot;integratedTerminal&quot;</code> to give the program a
              real terminal for stdin, stdout and stderr.
            </div>
          </>
        ) : usingInternalConsole ? (
          <>
            <div className="terminal-placeholder-title">Program stdin is not attached</div>
            <div className="terminal-placeholder-text">
              This configuration uses the internal console, which has no stdin (VS Code&apos;s
              default has the same limitation). Set{' '}
              <code>&quot;console&quot;: &quot;integratedTerminal&quot;</code> in launch.json to
              attach the program to a pty.
            </div>
            <button className="link" onClick={() => void openLaunchJson()}>
              Open launch.json
            </button>
          </>
        ) : (
          <>
            <div className="terminal-placeholder-title">Starting integrated terminal…</div>
            <div className="terminal-placeholder-text">
              Waiting for the debug adapter to allocate a pty.
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function TerminalView(): ReactNode {
  const terminal = useDebugStore((state) => state.terminal);
  if (terminal.available || terminal.chunks.length > 0) {
    return <TerminalCanvas />;
  }
  return <TerminalPlaceholder />;
}
