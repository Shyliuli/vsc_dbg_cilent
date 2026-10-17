import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { commandById, type AppCommand } from '../commands.ts';
import { useDebugStore } from '../debug/store.ts';
import { getActiveEditor } from '../editor/registry.ts';
import { openCommandPalette } from '../ui/events.ts';
import { Codicon } from './Icons.tsx';

interface MenuEntry {
  command?: string;
  label?: string;
  keybinding?: string;
  action?: () => void;
  separator?: boolean;
  disabled?: () => boolean;
}

interface MenuDefinition {
  label: string;
  entries: MenuEntry[];
}

function runEditorAction(actionId: string): void {
  const editor = getActiveEditor();
  if (editor) {
    void editor.getAction(actionId)?.run();
  }
}

function menuDefinitions(): MenuDefinition[] {
  return [
    {
      label: 'File',
      entries: [
        { command: 'file.openLaunchJson' },
        { separator: true },
        { command: 'file.save' },
        { command: 'file.saveAll' },
        { separator: true },
        { command: 'file.closeEditor' },
        { command: 'file.closeAllEditors' },
      ],
    },
    {
      label: 'Edit',
      entries: [
        { label: 'Find', keybinding: 'Ctrl+F', action: () => runEditorAction('actions.find') },
        { label: 'Replace', keybinding: 'Ctrl+H', action: () => runEditorAction('editor.action.startFindReplaceAction') },
        { separator: true },
        { label: 'Undo', keybinding: 'Ctrl+Z', action: () => runEditorAction('undo') },
        { label: 'Redo', keybinding: 'Ctrl+Y', action: () => runEditorAction('redo') },
      ],
    },
    {
      label: 'Selection',
      entries: [
        { label: 'Select All', keybinding: 'Ctrl+A', action: () => runEditorAction('editor.action.selectAll') },
        { label: 'Add Cursor Above', keybinding: 'Ctrl+Alt+Up', action: () => runEditorAction('editor.action.insertCursorAbove') },
        { label: 'Add Cursor Below', keybinding: 'Ctrl+Alt+Down', action: () => runEditorAction('editor.action.insertCursorBelow') },
        { label: 'Add Selection to Next Find Match', keybinding: 'Ctrl+D', action: () => runEditorAction('editor.action.addSelectionToNextFindMatch') },
      ],
    },
    {
      label: 'View',
      entries: [
        { command: 'view.commandPalette' },
        { command: 'go.file' },
        { separator: true },
        { command: 'view.explorer' },
        { command: 'view.debug' },
        { separator: true },
        { command: 'view.problems' },
        { command: 'view.output' },
        { command: 'view.debugConsole' },
        { command: 'view.terminal' },
        { command: 'view.togglePanel' },
        { command: 'view.toggleSidebar' },
        { separator: true },
        { command: 'debug.openDisassembly' },
        { command: 'debug.viewMemory' },
        { command: 'debug.toggleInlineValues' },
        { command: 'view.welcome' },
      ],
    },
    {
      label: 'Go',
      entries: [{ command: 'go.file' }, { separator: true }, { command: 'run.runToCursor' }],
    },
    {
      label: 'Run',
      entries: [
        { command: 'run.startOrContinue' },
        { command: 'run.stop' },
        { command: 'run.restart' },
        { separator: true },
        { command: 'run.pause' },
        { command: 'run.stepOver' },
        { command: 'run.stepInto' },
        { command: 'run.stepOut' },
        { command: 'run.runToCursor' },
        { separator: true },
        { command: 'debug.toggleBreakpoint' },
        { command: 'debug.addConditionalBreakpoint' },
        { command: 'debug.addLogpoint' },
        { command: 'debug.addFunctionBreakpoint' },
        { command: 'debug.addDataBreakpoint' },
        { command: 'debug.removeAllBreakpoints' },
        { command: 'debug.removeAllDataBreakpoints' },
        { separator: true },
        { command: 'debug.openDisassembly' },
        { command: 'debug.viewMemory' },
        { command: 'debug.addConfiguration' },
      ],
    },
    {
      label: 'Help',
      entries: [
        { command: 'view.welcome' },
        { command: 'help.shortcuts' },
        { separator: true },
        { command: 'help.about' },
      ],
    },
  ];
}

function resolveEntry(entry: MenuEntry): AppCommand | null {
  if (!entry.command) {
    return null;
  }
  return commandById(entry.command) ?? null;
}

export function TitleBar(): ReactNode {
  const workspace = useDebugStore((state) => state.workspace);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const menus = useMemo(() => menuDefinitions(), []);

  useEffect(() => {
    if (!openMenu) {
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpenMenu(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpenMenu(null);
      }
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [openMenu]);

  return (
    <div className="titlebar" ref={containerRef}>
      <div className="titlebar-left">
        <div className="titlebar-logo" title="gdb-client">
          <Codicon name="debug-alt" />
        </div>
        <nav className="menubar">
          {menus.map((menu) => (
            <div
              key={menu.label}
              className={`menubar-item${openMenu === menu.label ? ' open' : ''}`}
              onClick={() => setOpenMenu(openMenu === menu.label ? null : menu.label)}
              onMouseEnter={() => {
                if (openMenu) {
                  setOpenMenu(menu.label);
                }
              }}
              role="menuitem"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  setOpenMenu(menu.label);
                }
              }}
            >
              {menu.label}
              {openMenu === menu.label ? (
                <div className="menu-dropdown" onClick={(event) => event.stopPropagation()}>
                  {menu.entries.map((entry, index) => {
                    if (entry.separator) {
                      return <div key={`separator-${index}`} className="menu-separator" />;
                    }
                    const command = resolveEntry(entry);
                    const label = entry.label ?? command?.label ?? '';
                    const keybinding = entry.keybinding ?? command?.keybinding;
                    const action = entry.action ?? (command ? command.run : undefined);
                    return (
                      <button
                        key={entry.command ?? `${label}-${index}`}
                        className="menu-item"
                        disabled={!action}
                        onClick={() => {
                          setOpenMenu(null);
                          action?.();
                        }}
                      >
                        <span className="menu-item-label">{label}</span>
                        {keybinding ? <span className="menu-item-keybinding">{keybinding}</span> : null}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          ))}
        </nav>
      </div>

      <button className="command-center" onClick={openCommandPalette} title="Search commands (Ctrl+Shift+P)">
        <Codicon name="search" />
        <span>{workspace?.name ?? 'gdb-client'}</span>
      </button>

      <div className="titlebar-right">
        <button className="titlebar-button" title="Toggle Panel (Ctrl+`)" onClick={() => useDebugStore.getState().togglePanel()}>
          <Codicon name="layout-panel" />
        </button>
        <button className="titlebar-button" title="Toggle Primary Side Bar (Ctrl+B)" onClick={() => useDebugStore.getState().toggleSidebar()}>
          <Codicon name="layout-sidebar-left" />
        </button>
      </div>
    </div>
  );
}
