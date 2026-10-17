import { useEffect, useState } from 'react';

import { runCommand } from './commands.ts';
import { useDebugStore } from './debug/store.ts';
import { ActivityBar } from './components/ActivityBar.tsx';
import { CommandPalette } from './components/CommandPalette.tsx';
import { ContextMenu } from './components/ContextMenu.tsx';
import { EditorArea } from './components/EditorArea.tsx';
import { Notifications } from './components/Notifications.tsx';
import { QuickInput } from './components/QuickInput.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { StatusBar } from './components/StatusBar.tsx';
import { TitleBar } from './components/TitleBar.tsx';
import { OPEN_COMMAND_PALETTE_EVENT } from './ui/events.ts';

export function App() {
  const bootstrap = useDebugStore((state) => state.bootstrap);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    const open = () => setPaletteOpen(true);
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, open);
    return () => window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, open);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const command = event.ctrlKey || event.metaKey;
      const shift = event.shiftKey;
      const key = event.key;

      // xterm handles typing (including Ctrl+W/Ctrl+P and other shell keys)
      // itself. Only let debugger function keys and the workbench combos we
      // own through while the terminal is focused.
      if (event.target instanceof HTMLElement && event.target.closest('.xterm')) {
        const isFunctionKey = /^F([1-9]|1[0-2])$/.test(key);
        const isWorkbenchCombo =
          command && (key === 'F10' || (shift && ['p', 'd', 'e', 'y'].includes(key.toLowerCase())));
        if (!isFunctionKey && !isWorkbenchCombo) {
          return;
        }
      }

      if (key === 'Escape') {
        if (paletteOpen) {
          event.preventDefault();
          setPaletteOpen(false);
          return;
        }
        const state = useDebugStore.getState();
        if (state.quickInput) {
          state.setQuickInput(null);
          return;
        }
        if (state.contextMenu) {
          state.setContextMenu(null);
        }
        return;
      }

      if (key === 'F5') {
        event.preventDefault();
        if (shift) {
          runCommand(command ? 'run.restart' : 'run.stop');
        } else {
          runCommand('run.startOrContinue');
        }
        return;
      }
      if (key === 'F6') {
        event.preventDefault();
        runCommand('run.pause');
        return;
      }
      if (key === 'F9') {
        event.preventDefault();
        runCommand(shift ? 'debug.addConditionalBreakpoint' : 'debug.toggleBreakpoint');
        return;
      }
      if (key === 'F10') {
        event.preventDefault();
        runCommand(command ? 'run.runToCursor' : 'run.stepOver');
        return;
      }
      if (key === 'F11') {
        event.preventDefault();
        runCommand(shift ? 'run.stepOut' : 'run.stepInto');
        return;
      }
      if (key === 'F1') {
        event.preventDefault();
        setPaletteOpen(true);
        return;
      }

      if (!command) {
        return;
      }
      if (shift && key.toLowerCase() === 'p') {
        event.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (key.toLowerCase() === 'p') {
        event.preventDefault();
        runCommand('go.file');
        return;
      }
      if (shift && key.toLowerCase() === 'd') {
        event.preventDefault();
        runCommand('view.debug');
        return;
      }
      if (shift && key.toLowerCase() === 'e') {
        event.preventDefault();
        runCommand('view.explorer');
        return;
      }
      if (shift && key.toLowerCase() === 'y') {
        event.preventDefault();
        runCommand('view.debugConsole');
        return;
      }
      if (key.toLowerCase() === 'b') {
        event.preventDefault();
        runCommand('view.toggleSidebar');
        return;
      }
      if (key === '`') {
        event.preventDefault();
        runCommand('view.togglePanel');
        return;
      }
      if (key.toLowerCase() === 's') {
        if (event.target instanceof HTMLElement && event.target.closest('.monaco-editor')) {
          // Monaco's Ctrl+S command owns saving inside editors.
          return;
        }
        event.preventDefault();
        runCommand('file.save');
        return;
      }
      if (key.toLowerCase() === 'w') {
        event.preventDefault();
        runCommand('file.closeEditor');
      }
    };
    // Capture so debug shortcuts still work while xterm's textarea swallows
    // keydown events (F5 while the terminal is focused, for example).
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [paletteOpen]);

  return (
    <div className="app">
      <TitleBar />
      <div className="app-body">
        <ActivityBar />
        <div className="sidebar-slot">
          <Sidebar />
        </div>
        <EditorArea />
      </div>
      <StatusBar />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <QuickInput />
      <ContextMenu />
      <Notifications />
    </div>
  );
}
