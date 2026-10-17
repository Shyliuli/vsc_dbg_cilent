import type { ReactNode } from 'react';

import { basename, stopKindLabel } from '../../debug/format.ts';
import { useDebugStore } from '../../debug/store.ts';
import { Codicon } from '../Icons.tsx';

export function CallStackView(): ReactNode {
  const status = useDebugStore((state) => state.status);
  const frames = useDebugStore((state) => state.frames);
  const framesHasMore = useDebugStore((state) => state.framesHasMore);
  const selectedFrameId = useDebugStore((state) => state.selectedFrameId);
  const threads = useDebugStore((state) => state.threads);
  const currentThreadId = useDebugStore((state) => state.currentThreadId);
  const stopKind = useDebugStore((state) => state.stopKind);
  const hitDataBreakpointId = useDebugStore((state) => state.hitDataBreakpointId);
  const dataBreakpoints = useDebugStore((state) => state.dataBreakpoints);
  const stopDescription = useDebugStore((state) => state.stopDescription);
  const selectFrame = useDebugStore((state) => state.selectFrame);
  const selectThread = useDebugStore((state) => state.selectThread);
  const loadMoreFrames = useDebugStore((state) => state.loadMoreFrames);
  const openSource = useDebugStore((state) => state.openSource);
  const setContextMenu = useDebugStore((state) => state.setContextMenu);

  if (status === 'inactive' || status === 'error') {
    return <div className="tree-empty">Start a debug session to inspect the call stack.</div>;
  }

  if (status === 'running' || status === 'initializing') {
    return (
      <div className="tree-empty">
        <Codicon name="loading" spin /> {status === 'running' ? 'Running…' : 'Starting…'}
      </div>
    );
  }

  if (status === 'terminated') {
    return <div className="tree-empty">The debug session has terminated.</div>;
  }

  const hitDataBreakpoint = dataBreakpoints.find(
    (breakpoint) => breakpoint.id === hitDataBreakpointId,
  );
  const stopLabel = hitDataBreakpoint
    ? `Paused on data breakpoint: ${hitDataBreakpoint.expression}`
    : stopKindLabel(stopKind);

  const threadNameCounts = new Map<string, number>();
  for (const thread of threads) {
    threadNameCounts.set(thread.name, (threadNameCounts.get(thread.name) ?? 0) + 1);
  }
  const threadLabel = (thread: { id: number; name: string }) => {
    if (!thread.name) {
      return `Thread #${thread.id}`;
    }
    return (threadNameCounts.get(thread.name) ?? 0) > 1 ? `${thread.name} (#${thread.id})` : thread.name;
  };

  return (
    <div className="callstack">
      <div className="callstack-status" title={stopDescription ?? undefined}>
        <span className="callstack-reason">{stopLabel}</span>
        {threads.length > 1 ? (
          <select
            id="thread-select"
            name="thread-select"
            aria-label="Thread"
            className="thread-select"
            value={currentThreadId ?? ''}
            onChange={(event) => void selectThread(Number(event.target.value))}
            title="Threads"
          >
            {threads.map((thread) => (
              <option key={thread.id} value={thread.id}>
                {threadLabel(thread)}
              </option>
            ))}
          </select>
        ) : threads.length === 1 ? (
          <span className="callstack-thread">{threadLabel(threads[0])}</span>
        ) : null}
      </div>
      <div className="tree">
        {frames.map((frame) => {
          const selected = frame.id === selectedFrameId;
          const location = frame.sourcePath
            ? `${basename(frame.sourcePath)}:${frame.line}`
            : frame.line
              ? `line ${frame.line}`
              : '';
          return (
            <div
              key={frame.id}
              className={`tree-row frame-row${selected ? ' selected' : ''}`}
              onClick={() => {
                void selectFrame(frame.id);
                if (frame.sourcePath) {
                  void openSource(frame.sourcePath, frame.line, { pinned: true });
                }
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                setContextMenu({
                  x: event.clientX,
                  y: event.clientY,
                  items: [
                    {
                      label: 'Open Source',
                      disabled: !frame.sourcePath,
                      action: () => {
                        if (frame.sourcePath) {
                          void openSource(frame.sourcePath, frame.line, { pinned: true });
                        }
                      },
                    },
                    {
                      label: 'Copy Call Stack',
                      action: () => {
                        void navigator.clipboard.writeText(frames.map((entry) => entry.name).join('\n'));
                      },
                    },
                  ],
                });
              }}
              title={`${frame.name}${location ? ` (${location})` : ''}`}
            >
              <Codicon
                name={selected ? 'debug-stackframe-focused' : 'debug-stackframe'}
                className="frame-icon"
              />
              <span className="frame-name">{frame.name}</span>
              {location ? <span className="frame-location">{location}</span> : null}
            </div>
          );
        })}
        {frames.length === 0 ? <div className="tree-empty small">No stack frames.</div> : null}
        {framesHasMore ? (
          <button className="tree-more" onClick={() => void loadMoreFrames()}>
            Load more frames…
          </button>
        ) : null}
      </div>
    </div>
  );
}
