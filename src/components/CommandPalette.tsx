import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { getCommands, type AppCommand } from '../commands.ts';
import { Codicon } from './Icons.tsx';

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

function matches(command: AppCommand, query: string): boolean {
  if (!query) {
    return true;
  }
  const haystack = `${command.category}: ${command.label}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term));
}

export function CommandPalette(props: CommandPaletteProps): ReactNode {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const commands = useMemo(() => (props.open ? getCommands() : []), [props.open]);
  const filtered = useMemo(
    () => commands.filter((command) => matches(command, query)).slice(0, 60),
    [commands, query],
  );

  useEffect(() => {
    if (props.open) {
      setQuery('');
      setSelected(0);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [props.open]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  useEffect(() => {
    const item = listRef.current?.querySelector<HTMLElement>('.command-palette-item.selected');
    item?.scrollIntoView({ block: 'nearest' });
  }, [selected, filtered.length]);

  if (!props.open) {
    return null;
  }

  const execute = (command: AppCommand | undefined) => {
    if (!command) {
      return;
    }
    props.onClose();
    // Let the overlay disappear before an action opens another surface.
    window.setTimeout(() => command.run(), 0);
  };

  return (
    <div className="command-palette-overlay" onMouseDown={props.onClose}>
      <div className="command-palette" onMouseDown={(event) => event.stopPropagation()}>
        <div className="command-palette-input-row">
          <span className="command-palette-prefix">&gt;</span>
          <input
            ref={inputRef}
            id="command-palette-input"
            name="command-palette-input"
            aria-label="Command palette"
            className="command-palette-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                props.onClose();
              } else if (event.key === 'Enter') {
                event.preventDefault();
                execute(filtered[selected]);
              } else if (event.key === 'ArrowDown') {
                event.preventDefault();
                setSelected((current) => Math.min(filtered.length - 1, current + 1));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setSelected((current) => Math.max(0, current - 1));
              }
            }}
            placeholder="Type the name of a command to run"
            spellCheck={false}
            autoComplete="off"
          />
        </div>
        <div className="command-palette-list" ref={listRef}>
          {filtered.map((command, index) => (
            <button
              key={command.id}
              className={`command-palette-item${index === selected ? ' selected' : ''}`}
              onMouseEnter={() => setSelected(index)}
              onClick={() => execute(command)}
            >
              <Codicon name="debug-alt" className="command-palette-icon" />
              <span className="command-palette-label">{command.label}</span>
              <span className="command-palette-category">{command.category}</span>
              {command.keybinding ? (
                <span className="command-palette-keybinding">{command.keybinding}</span>
              ) : null}
            </button>
          ))}
          {filtered.length === 0 ? <div className="command-palette-empty">No matching commands</div> : null}
        </div>
      </div>
    </div>
  );
}
