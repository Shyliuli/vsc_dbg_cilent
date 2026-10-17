import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import { useDebugStore } from '../../debug/store.ts';

const ANSI_COLORS: Record<number, string> = {
  30: '#000000',
  31: '#CD3131',
  32: '#0DBC79',
  33: '#E5E510',
  34: '#2472C8',
  35: '#BC3FBC',
  36: '#11A8CD',
  37: '#E5E5E5',
  90: '#666666',
  91: '#F14C4C',
  92: '#23D18B',
  93: '#F5F543',
  94: '#3B8EEA',
  95: '#D670D6',
  96: '#29B8DB',
  97: '#E5E5E5',
};

/** Render the ANSI SGR sequences gdb and the inferior may emit. */
export function renderAnsi(text: string, baseStyle?: CSSProperties): ReactNode[] {
  const nodes: ReactNode[] = [];
  const regex = /\u001b\[([0-9;]*)m/g;
  let style: CSSProperties = { ...baseStyle };
  let lastIndex = 0;
  let key = 0;
  let match: RegExpExecArray | null;

  const push = (value: string) => {
    if (value.length > 0) {
      nodes.push(
        <span key={key++} style={style}>
          {value}
        </span>,
      );
    }
  };

  while ((match = regex.exec(text)) !== null) {
    push(text.slice(lastIndex, match.index));
    lastIndex = regex.lastIndex;
    const codes = match[1].length === 0 ? [0] : match[1].split(';').map((value) => Number.parseInt(value, 10));
    for (const code of codes) {
      if (code === 0) {
        style = { ...baseStyle };
      } else if (code === 1) {
        style = { ...style, fontWeight: 700 };
      } else if (code === 2) {
        style = { ...style, opacity: 0.7 };
      } else if (code === 3) {
        style = { ...style, fontStyle: 'italic' };
      } else if (code === 4) {
        style = { ...style, textDecoration: 'underline' };
      } else if (code === 22) {
        style = { ...style, fontWeight: 'normal', opacity: 1 };
      } else if (code === 39) {
        style = { ...style, color: baseStyle?.color };
      } else if (ANSI_COLORS[code]) {
        style = { ...style, color: ANSI_COLORS[code] };
      }
    }
  }
  push(text.slice(lastIndex));
  return nodes;
}

export function DebugConsole(): ReactNode {
  const lines = useDebugStore((state) => state.consoleLines);
  const executeConsoleCommand = useDebugStore((state) => state.executeConsoleCommand);
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoScrollRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }
    const onScroll = () => {
      autoScrollRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
    };
    element.addEventListener('scroll', onScroll);
    return () => element.removeEventListener('scroll', onScroll);
  }, []);

  const submit = () => {
    const command = input.trim();
    if (!command) {
      return;
    }
    setHistory((current) => [...current, command]);
    setHistoryIndex(null);
    setInput('');
    autoScrollRef.current = true;
    void executeConsoleCommand(command);
  };

  return (
    <div className="debug-console">
      <div className="console-lines" ref={scrollRef}>
        {lines.length === 0 ? (
          <div className="console-empty">
            Evaluate expressions, call functions, or run gdb commands while the program is paused.
          </div>
        ) : null}
        {lines.map((line) => {
          if (line.kind === 'input') {
            return (
              <div key={line.id} className="console-line input">
                <span className="console-prompt">&gt;</span>
                <span className="console-command">{line.text}</span>
              </div>
            );
          }
          const className =
            line.kind === 'error' || line.kind === 'stderr'
              ? 'console-line error'
              : line.kind === 'info'
                ? 'console-line info'
                : line.kind === 'result'
                  ? 'console-line result'
                  : 'console-line';
          return (
            <div key={line.id} className={className}>
              {renderAnsi(line.text.replace(/\n$/, ''))}
            </div>
          );
        })}
      </div>
      <div className="console-input-row" onClick={() => inputRef.current?.focus()}>
        <span className="console-prompt">&gt;</span>
        <input
          ref={inputRef}
          id="debug-console-input"
          name="debug-console-input"
          aria-label="Debug Console input"
          className="console-input"
          value={input}
          placeholder="Evaluate expressions or run gdb commands"
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              submit();
            } else if (event.key === 'ArrowUp') {
              if (history.length > 0) {
                event.preventDefault();
                const index = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
                setHistoryIndex(index);
                setInput(history[index] ?? '');
              }
            } else if (event.key === 'ArrowDown') {
              if (historyIndex !== null) {
                event.preventDefault();
                const index = historyIndex + 1;
                if (index >= history.length) {
                  setHistoryIndex(null);
                  setInput('');
                } else {
                  setHistoryIndex(index);
                  setInput(history[index] ?? '');
                }
              }
            }
          }}
          spellCheck={false}
          autoComplete="off"
        />
      </div>
    </div>
  );
}
