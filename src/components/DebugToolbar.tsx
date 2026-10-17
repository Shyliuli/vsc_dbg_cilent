import type { ReactNode } from 'react';

import { useDebugStore } from '../debug/store.ts';
import { Codicon } from './Icons.tsx';

interface ToolbarButton {
  icon: string;
  title: string;
  disabled: boolean;
  onClick: () => void;
}

export function DebugToolbar(): ReactNode {
  const status = useDebugStore((state) => state.status);
  const activeConfig = useDebugStore((state) => state.activeConfig);
  const stopKind = useDebugStore((state) => state.stopKind);
  const frames = useDebugStore((state) => state.frames);
  const selectedFrameId = useDebugStore((state) => state.selectedFrameId);
  const continueExecution = useDebugStore((state) => state.continueExecution);
  const pauseExecution = useDebugStore((state) => state.pauseExecution);
  const stepOver = useDebugStore((state) => state.stepOver);
  const stepInto = useDebugStore((state) => state.stepInto);
  const stepOut = useDebugStore((state) => state.stepOut);
  const restartDebugging = useDebugStore((state) => state.restartDebugging);
  const stopDebugging = useDebugStore((state) => state.stopDebugging);

  if (status === 'inactive' || status === 'error') {
    return null;
  }

  const stopped = status === 'stopped';
  const selectedFrame = frames.find((frame) => frame.id === selectedFrameId);
  const location =
    status === 'terminated'
      ? 'Terminated'
      : status === 'initializing'
        ? 'Starting…'
        : selectedFrame
          ? `${selectedFrame.name}${selectedFrame.sourceName ? ` — ${selectedFrame.sourceName}:${selectedFrame.line}` : ''}`
          : status === 'running'
            ? 'Running…'
            : stopKind === 'entry'
              ? 'Paused on entry'
              : 'Paused';

  const buttons: ToolbarButton[] = [
    {
      icon: stopped ? 'debug-continue' : 'debug-pause',
      title: stopped ? 'Continue (F5)' : 'Pause (F6)',
      disabled: !stopped && status !== 'running',
      onClick: stopped ? continueExecution : pauseExecution,
    },
    { icon: 'debug-step-over', title: 'Step Over (F10)', disabled: !stopped, onClick: () => stepOver() },
    { icon: 'debug-step-into', title: 'Step Into (F11)', disabled: !stopped, onClick: () => stepInto() },
    { icon: 'debug-step-out', title: 'Step Out (Shift+F11)', disabled: !stopped, onClick: () => stepOut() },
    {
      icon: 'debug-restart',
      title: 'Restart (Ctrl+Shift+F5)',
      disabled: status === 'initializing',
      onClick: () => void restartDebugging(),
    },
    {
      icon: activeConfig?.request === 'attach' ? 'debug-disconnect' : 'debug-stop',
      title:
        activeConfig?.request === 'attach' ? 'Disconnect (Shift+F5)' : 'Stop (Shift+F5)',
      disabled: false,
      onClick: () => void stopDebugging(),
    },
  ];

  return (
    <div className="debug-toolbar">
      <div className="debug-toolbar-buttons">
        {buttons.map((button) => (
          <button
            key={button.icon}
            className="debug-toolbar-button"
            disabled={button.disabled}
            title={button.title}
            aria-label={button.title}
            onClick={button.onClick}
          >
            <Codicon name={button.icon} />
          </button>
        ))}
      </div>
      <div className="debug-toolbar-location" title={location}>
        {location}
      </div>
    </div>
  );
}
