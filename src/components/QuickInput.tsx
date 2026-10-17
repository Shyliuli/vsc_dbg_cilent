import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { useDebugStore } from '../debug/store.ts';
import type { QuickInputState } from '../debug/types.ts';
import { Codicon } from './Icons.tsx';

function matches(item: { label: string; description?: string; detail?: string }, filter: string): boolean {
  if (!filter) {
    return true;
  }
  const haystack = `${item.label} ${item.description ?? ''} ${item.detail ?? ''}`.toLowerCase();
  return filter
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term));
}

export function QuickInput(): ReactNode {
  const quickInput = useDebugStore((state) => state.quickInput);
  const setQuickInput = useDebugStore((state) => state.setQuickInput);
  const [filter, setFilter] = useState('');
  const [value, setValue] = useState('');
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setFilter('');
    setValue(quickInput?.value ?? '');
    setSelected(0);
    setError(null);
    if (quickInput) {
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [quickInput]);

  const items: QuickInputState['items'] = quickInput?.items;
  const filtered = useMemo(
    () => (items ? items.filter((item) => matches(item, filter)).slice(0, 40) : []),
    [items, filter],
  );

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selected, filtered.length]);

  if (!quickInput) {
    return null;
  }

  const close = () => setQuickInput(null);

  const submit = () => {
    if (items) {
      const item = filtered[selected];
      if (item) {
        setQuickInput(null);
        item.action();
      } else {
        void quickInput.onSubmit(filter);
      }
      return;
    }
    const validation = quickInput.validate?.(value);
    if (validation) {
      setError(validation);
      return;
    }
    void quickInput.onSubmit(value);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
      return;
    }
    if (items) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelected((current) => Math.min(filtered.length - 1, current + 1));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelected((current) => Math.max(0, current - 1));
      }
    }
  };

  return (
    <div className="quick-input-overlay" onMouseDown={close}>
      <div className="quick-input" onMouseDown={(event) => event.stopPropagation()}>
        <div className="quick-input-title">{quickInput.title}</div>
        {quickInput.prompt ? <div className="quick-input-prompt">{quickInput.prompt}</div> : null}
        <input
          ref={inputRef}
          id="quick-input-field"
          name="quick-input-field"
          aria-label={quickInput.title}
          className="quick-input-field"
          value={items ? filter : value}
          placeholder={quickInput.placeholder ?? ''}
          onChange={(event) => {
            if (items) {
              setFilter(event.target.value);
              setSelected(0);
            } else {
              setValue(event.target.value);
              setError(null);
            }
          }}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoComplete="off"
        />
        {error ? <div className="quick-input-error">{error}</div> : null}
        {items ? (
          <div className="quick-input-list" role="listbox">
            {filtered.map((item, index) => (
              <button
                key={`${item.label}-${index}`}
                ref={index === selected ? selectedRef : undefined}
                className={`quick-input-item${index === selected ? ' selected' : ''}`}
                onMouseEnter={() => setSelected(index)}
                onClick={() => {
                  setQuickInput(null);
                  item.action();
                }}
                role="option"
                aria-selected={index === selected}
              >
                {item.icon ? <Codicon name={item.icon} /> : null}
                <span className="quick-input-item-label">{item.label}</span>
                {item.description ? (
                  <span className="quick-input-item-description">{item.description}</span>
                ) : null}
                {item.detail ? <span className="quick-input-item-detail">{item.detail}</span> : null}
              </button>
            ))}
            {filtered.length === 0 ? <div className="quick-input-empty">No matching results</div> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
