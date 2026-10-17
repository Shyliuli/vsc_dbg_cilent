import { useEffect, useRef, type ReactNode } from 'react';

import { basename } from '../debug/format.ts';
import { useDebugStore } from '../debug/store.ts';
import type { EditorTab } from '../debug/types.ts';
import { Codicon } from './Icons.tsx';

function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

export function DisassemblyView(props: { tab: EditorTab }): ReactNode {
  const tab = props.tab;
  const status = useDebugStore((state) => state.status);
  const instructionBreakpoints = useDebugStore((state) => state.instructionBreakpoints);
  const toggleInstructionBreakpoint = useDebugStore((state) => state.toggleInstructionBreakpoint);
  const removeInstructionBreakpoint = useDebugStore((state) => state.removeInstructionBreakpoint);
  const reloadDisassembly = useDebugStore((state) => state.reloadDisassembly);
  const loadMoreDisassembly = useDebugStore((state) => state.loadMoreDisassembly);
  const setDisassemblyFollow = useDebugStore((state) => state.setDisassemblyFollow);
  const openSource = useDebugStore((state) => state.openSource);
  const openMemoryView = useDebugStore((state) => state.openMemoryView);
  const continueExecution = useDebugStore((state) => state.continueExecution);
  const stepOver = useDebugStore((state) => state.stepOver);
  const stepInto = useDebugStore((state) => state.stepInto);
  const stepOut = useDebugStore((state) => state.stepOut);
  const restartDebugging = useDebugStore((state) => state.restartDebugging);
  const stopDebugging = useDebugStore((state) => state.stopDebugging);
  const setContextMenu = useDebugStore((state) => state.setContextMenu);
  const selectedFrame = useDebugStore((state) => state.frames.find((frame) => frame.id === state.selectedFrameId));

  const disassembly = tab.disassembly;
  const listRef = useRef<HTMLDivElement>(null);
  const stopped = status === 'stopped';

  useEffect(() => {
    if (!disassembly || !disassembly.follow) {
      return;
    }
    const pc = disassembly.pc ? normalizeAddress(disassembly.pc) : null;
    if (!pc) {
      return;
    }
    const row = listRef.current?.querySelector<HTMLElement>(`[data-address="${pc}"]`);
    row?.scrollIntoView({ block: 'center' });
  }, [disassembly?.instructions, disassembly?.pc, disassembly?.follow]);

  if (!disassembly) {
    return <div className="editor-placeholder">Disassembly data is unavailable.</div>;
  }

  const showSource = () => {
    if (selectedFrame?.sourcePath) {
      void openSource(selectedFrame.sourcePath, selectedFrame.line, { pinned: true });
    }
  };

  return (
    <div className="disassembly">
      <div className="disassembly-toolbar">
        <button title="Continue (F5)" disabled={!stopped} onClick={continueExecution}>
          <Codicon name="debug-continue" />
        </button>
        <button title="Step Over (F10, instruction)" disabled={!stopped} onClick={() => stepOver('instruction')}>
          <Codicon name="debug-step-over" />
        </button>
        <button title="Step Into (F11, instruction)" disabled={!stopped} onClick={() => stepInto('instruction')}>
          <Codicon name="debug-step-into" />
        </button>
        <button title="Step Out (Shift+F11)" disabled={!stopped} onClick={stepOut}>
          <Codicon name="debug-step-out" />
        </button>
        <button title="Restart (Ctrl+Shift+F5)" onClick={() => void restartDebugging()}>
          <Codicon name="debug-restart" />
        </button>
        <button title="Stop (Shift+F5)" onClick={() => void stopDebugging()}>
          <Codicon name="debug-stop" />
        </button>
        <span className="toolbar-separator" />
        <button
          title="Follow the current instruction"
          className={disassembly.follow ? 'active' : ''}
          onClick={() => setDisassemblyFollow(tab.id, !disassembly.follow)}
        >
          <Codicon name="eye" />
        </button>
        <button title="Open Source" disabled={!selectedFrame?.sourcePath} onClick={showSource}>
          <Codicon name="file-code" />
        </button>
        <button title="Reload" disabled={!stopped} onClick={() => void reloadDisassembly(tab.id)}>
          <Codicon name="refresh" />
        </button>
        <span className="disassembly-title">
          {disassembly.base ? normalizeAddress(disassembly.base) : ''}
        </span>
      </div>

      {disassembly.error ? (
        <div className="editor-placeholder">
          <Codicon name="warning" />
          <div>{disassembly.error}</div>
        </div>
      ) : null}

      <div className="disassembly-list" ref={listRef}>
        {disassembly.instructions.map((instruction) => {
          const address = normalizeAddress(instruction.address);
          const isPc = disassembly.pc !== undefined && normalizeAddress(disassembly.pc) === address;
          const breakpoint = instructionBreakpoints.find(
            (entry) => normalizeAddress(entry.instructionReference) === address,
          );
          return (
            <div
              key={instruction.address}
              data-address={address}
              className={`dis-row${isPc ? ' pc' : ''}`}
              onContextMenu={(event) => {
                event.preventDefault();
                setContextMenu({
                  x: event.clientX,
                  y: event.clientY,
                  items: [
                    {
                      label: breakpoint ? 'Remove Instruction Breakpoint' : 'Set Instruction Breakpoint',
                      action: () =>
                        breakpoint
                          ? void removeInstructionBreakpoint(breakpoint.id)
                          : void toggleInstructionBreakpoint(instruction.address),
                    },
                    {
                      label: 'View Memory',
                      action: () => void openMemoryView({ address: instruction.address }),
                    },
                    {
                      label: 'Copy Address',
                      action: () => void navigator.clipboard.writeText(instruction.address),
                    },
                    {
                      label: 'Open Source',
                      disabled: !instruction.sourcePath,
                      action: () => {
                        if (instruction.sourcePath) {
                          void openSource(instruction.sourcePath, instruction.line ?? 1, { pinned: true });
                        }
                      },
                    },
                  ],
                });
              }}
            >
              <span
                className="dis-gutter"
                role="button"
                tabIndex={0}
                title={breakpoint ? 'Remove Instruction Breakpoint' : 'Set Instruction Breakpoint'}
                onClick={(event) => {
                  event.stopPropagation();
                  void toggleInstructionBreakpoint(instruction.address);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    void toggleInstructionBreakpoint(instruction.address);
                  }
                }}
              >
                <Codicon
                  name={breakpoint ? 'debug-breakpoint' : 'circle-outline'}
                  className={breakpoint ? 'breakpoint-icon default' : 'dis-gutter-dot'}
                />
              </span>
              {isPc ? <Codicon name="arrow-right" className="dis-pc-arrow" /> : <span className="dis-pc-spacer" />}
              <span className="dis-address">{instruction.address}</span>
              <span className="dis-bytes">{instruction.instructionBytes ?? ''}</span>
              <span className="dis-instruction">
                {instruction.symbol ? <span className="dis-symbol">{instruction.symbol}:</span> : null}
                {instruction.instruction}
              </span>
              {instruction.sourcePath ? (
                <button
                  className="dis-source"
                  title={instruction.sourcePath}
                  onClick={() =>
                    void openSource(instruction.sourcePath as string, instruction.line ?? 1, {
                      pinned: true,
                    })
                  }
                >
                  {basename(instruction.sourcePath)}:{instruction.line}
                </button>
              ) : null}
            </div>
          );
        })}
        {disassembly.loading ? (
          <div className="dis-hint">
            <Codicon name="loading" spin /> Loading…
          </div>
        ) : null}
        {!disassembly.loading && disassembly.instructions.length === 0 && !disassembly.error ? (
          <div className="dis-hint">No instructions loaded.</div>
        ) : null}
        {disassembly.hasMore ? (
          <button className="dis-more" onClick={() => void loadMoreDisassembly(tab.id)}>
            Load more instructions…
          </button>
        ) : null}
      </div>
    </div>
  );
}
