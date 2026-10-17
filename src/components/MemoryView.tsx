import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { useDebugStore } from '../debug/store.ts';
import type { EditorTab } from '../debug/types.ts';
import { Codicon } from './Icons.tsx';

const BYTES_PER_ROW = 16;
const PAGE_BYTES = 256;

function hexAddress(address: string): string {
  try {
    return `0x${BigInt(address).toString(16)}`;
  } catch {
    return address;
  }
}

function addToAddress(address: string, delta: number): string | null {
  try {
    return `0x${(BigInt(address) + BigInt(delta)).toString(16)}`;
  } catch {
    return null;
  }
}

export function MemoryView(props: { tab: EditorTab }): ReactNode {
  const tab = props.tab;
  const memory = tab.memory;
  const reloadMemory = useDebugStore((state) => state.reloadMemory);
  const setMemoryAddress = useDebugStore((state) => state.setMemoryAddress);
  const status = useDebugStore((state) => state.status);
  const [input, setInput] = useState(memory?.address ?? '');

  useEffect(() => {
    setInput(memory?.address ?? '');
  }, [memory?.address]);

  const rows = useMemo(() => {
    if (!memory?.bytes) {
      return [];
    }
    const result: Array<{ address: string; bytes: string[]; ascii: string }> = [];
    const bytes = memory.bytes.match(/../g) ?? [];
    for (let offset = 0; offset < bytes.length; offset += BYTES_PER_ROW) {
      const slice = bytes.slice(offset, offset + BYTES_PER_ROW);
      const address = addToAddress(memory.address, offset) ?? memory.address;
      const ascii = slice
        .map((byte) => {
          const value = Number.parseInt(byte, 16);
          return value >= 0x20 && value <= 0x7e ? String.fromCharCode(value) : '.';
        })
        .join('');
      result.push({ address, bytes: slice, ascii });
    }
    return result;
  }, [memory?.bytes, memory?.address]);

  if (!memory) {
    return <div className="editor-placeholder">Memory data is unavailable.</div>;
  }

  const go = (value: string) => {
    if (value.trim()) {
      void setMemoryAddress(tab.id, value.trim());
    }
  };

  const page = (direction: -1 | 1) => {
    const next = memory.address ? addToAddress(memory.address, direction * PAGE_BYTES) : null;
    if (next) {
      void setMemoryAddress(tab.id, next);
    }
  };

  return (
    <div className="memory-view">
      <div className="memory-toolbar">
        <span className="memory-label">{memory.label ? `Memory: ${memory.label}` : 'Memory'}</span>
        <input
          id="memory-address-input"
          name="memory-address-input"
          aria-label="Memory address"
          className="memory-address-input"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              go(input);
            } else if (event.key === 'Escape') {
              setInput(memory.address);
            }
          }}
          placeholder="Address or expression, e.g. 0x7fffffffe000 or &counter"
          spellCheck={false}
        />
        <button title="Go to Address" onClick={() => go(input)}>
          <Codicon name="go-to-file" />
        </button>
        <button title="Previous Page (256 bytes)" onClick={() => page(-1)}>
          <Codicon name="chevron-up" />
        </button>
        <button title="Next Page (256 bytes)" onClick={() => page(1)}>
          <Codicon name="chevron-down" />
        </button>
        <button title="Refresh" disabled={!memory.address} onClick={() => void reloadMemory(tab.id)}>
          <Codicon name="refresh" />
        </button>
      </div>

      {memory.error ? (
        <div className="memory-error">
          <Codicon name="warning" /> {memory.error}
        </div>
      ) : null}

      <div className="memory-table">
        <div className="memory-header">
          <span className="memory-address">Address</span>
          <span className="memory-bytes-header">
            {Array.from({ length: BYTES_PER_ROW }, (_, index) => (
              <span key={index} className="memory-byte-header">
                {index.toString(16).padStart(2, '0')}
              </span>
            ))}
          </span>
          <span className="memory-ascii">ASCII</span>
        </div>
        {memory.loading ? (
          <div className="memory-loading">
            <Codicon name="loading" spin /> Reading memory…
          </div>
        ) : null}
        {rows.length === 0 && !memory.loading && !memory.error ? (
          <div className="memory-empty">No bytes read.</div>
        ) : null}
        {rows.map((row) => (
          <div key={row.address} className="memory-row">
            <span className="memory-address">{hexAddress(row.address)}</span>
            <span className="memory-bytes">
              {row.bytes.map((byte, index) => (
                <span key={index} className="memory-byte">
                  {byte}
                </span>
              ))}
            </span>
            <span className="memory-ascii">{row.ascii}</span>
          </div>
        ))}
      </div>

      <div className="memory-footer">
        <span>Read-only view backed by the DAP readMemory request.</span>
        <span>
          {status === 'stopped'
            ? 'Memory is refreshed on each stop.'
            : status === 'running'
              ? 'Pause the program to read memory.'
              : 'Start a session to read memory.'}
        </span>
      </div>
    </div>
  );
}
