import { useEffect, useRef, useState, type ReactNode } from 'react';

import { api } from '../api.ts';
import { basename } from '../debug/format.ts';
import { useDebugStore } from '../debug/store.ts';
import type { EditorTab, SourceBreakpoint } from '../debug/types.ts';
import { monaco } from '../editor/monaco.ts';
import { getActiveEditor, setActiveEditor } from '../editor/registry.ts';
import { Codicon } from './Icons.tsx';

const modelCache = new Map<string, monaco.editor.ITextModel>();
const NO_BREAKPOINTS: SourceBreakpoint[] = [];

const MONACO_LANGUAGE: Record<string, string> = {
  c: 'c',
  cpp: 'cpp',
  json: 'json',
  jsonc: 'json',
  python: 'python',
  javascript: 'javascript',
  typescript: 'typescript',
  shell: 'shell',
  markdown: 'markdown',
  rust: 'rust',
  go: 'go',
  java: 'java',
  css: 'css',
  html: 'html',
  yaml: 'yaml',
  ini: 'ini',
  plaintext: 'plaintext',
  asm: 'plaintext',
};

function truncate(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

export function SourceEditor(props: { tab: EditorTab }): ReactNode {
  const { tab } = props;
  const path = tab.path as string;
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const decorationIdsRef = useRef<string[]>([]);
  const inlineWidgetsRef = useRef<monaco.editor.IContentWidget[]>([]);
  const savedVersionRef = useRef<number>(0);
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'binary'>('loading');
  const [error, setError] = useState<string | null>(null);

  const breakpoints = useDebugStore((store) => store.breakpoints[path] ?? NO_BREAKPOINTS);
  const frames = useDebugStore((store) => store.frames);
  const selectedFrameId = useDebugStore((store) => store.selectedFrameId);
  const inlineValues = useDebugStore((store) => store.inlineValues);
  const revealLine = useDebugStore((store) => store.revealLine);
  const status = useDebugStore((store) => store.status);
  const tabDirty = useDebugStore(
    (store) => store.editorTabs.find((entry) => entry.id === tab.id)?.dirty ?? false,
  );

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const createEditor = (model: monaco.editor.ITextModel) => {
      const editor = monaco.editor.create(container, {
        model,
        theme: 'gdb-client-dark',
        glyphMargin: true,
        lineNumbersMinChars: 4,
        minimap: { enabled: true, renderCharacters: false, maxColumn: 90 },
        fontFamily: "'DejaVu Sans Mono', 'Droid Sans Mono', 'Liberation Mono', monospace",
        fontSize: 14,
        lineHeight: 19,
        renderLineHighlight: 'none',
        scrollBeyondLastLine: false,
        folding: true,
        automaticLayout: true,
        contextmenu: true,
        hover: { enabled: true, delay: 200 },
        bracketPairColorization: { enabled: true },
        guides: { indentation: true },
        smoothScrolling: true,
        tabSize: 4,
        padding: { top: 4 },
        overviewRulerBorder: false,
        scrollbar: { verticalScrollbarSize: 12, horizontalScrollbarSize: 12, useShadows: false },
      });
      editorRef.current = editor;
      savedVersionRef.current = model.getAlternativeVersionId();
      setActiveEditor(editor);
      if (import.meta.env.DEV) {
        (window as unknown as { __gdbClientEditor?: unknown }).__gdbClientEditor = editor;
      }

      // A tab opened by a debug stop may finish loading after the reveal
      // request was issued, so honor the pending request here as well.
      const pendingReveal = useDebugStore.getState().revealLine;
      if (pendingReveal && pendingReveal.path === path) {
        const line = Math.max(1, pendingReveal.line);
        editor.revealLineInCenter(line);
        editor.setPosition({ lineNumber: line, column: pendingReveal.column ?? 1 });
        useDebugStore.getState().setEditorCursor(line, pendingReveal.column ?? 1);
        editor.focus();
      }

      editor.onDidChangeModelContent(() => {
        const content = model.getValue();
        const dirty = model.getAlternativeVersionId() !== savedVersionRef.current;
        useDebugStore.getState().updateSourceContent(path, content, dirty);
      });

      editor.onDidChangeCursorPosition((event) => {
        useDebugStore.getState().setEditorCursor(event.position.lineNumber, event.position.column);
        setActiveEditor(editor);
      });

      editor.onDidFocusEditorWidget(() => setActiveEditor(editor));

      // Monaco creates its textareas after the editor mounts; give them stable
      // identifiers so assistive tech and form-field checks can label them.
      window.setTimeout(() => {
        for (const [selector, label] of [
          ['.ime-text-area', 'Text input IME'],
          ['.inputarea', 'Editor input'],
        ] as const) {
          const textarea = container.querySelector<HTMLTextAreaElement>(selector);
          if (textarea && !textarea.id) {
            textarea.id = `monaco-${label.toLowerCase().replace(/[^a-z]+/g, '-')}`;
            textarea.name = textarea.id;
            textarea.setAttribute('aria-label', label);
          }
        }
      }, 0);

      const gutterContextMenu = (line: number, x: number, y: number) => {
        const stateStore = useDebugStore.getState();
        const breakpoint = (stateStore.breakpoints[path] ?? []).find(
          (entry) => entry.line === line && !entry.temporary,
        );
        stateStore.setContextMenu({
          x,
          y,
          items: [
            {
              label: breakpoint ? 'Remove Breakpoint' : 'Add Breakpoint',
              action: () => void stateStore.toggleBreakpoint(path, line),
            },
            {
              label: 'Add Conditional Breakpoint…',
              action: () => void stateStore.addConditionalBreakpoint(path, line),
            },
            {
              label: 'Add Logpoint…',
              action: () => void stateStore.addLogpoint(path, line),
            },
            ...(breakpoint
              ? [
                  {
                    label: 'Edit Condition…',
                    action: () => void stateStore.editBreakpointCondition(breakpoint.id),
                  },
                  {
                    label: breakpoint.enabled ? 'Disable Breakpoint' : 'Enable Breakpoint',
                    action: () => void stateStore.setBreakpointEnabled(breakpoint.id, !breakpoint.enabled),
                  },
                ]
              : []),
            { separator: true },
            {
              label: 'Run to Cursor',
              action: () => void stateStore.runToCursor(path, line),
            },
            {
              label: 'Open Disassembly View',
              action: () => void stateStore.openDisassemblyView(),
            },
          ],
        });
      };

      editor.onMouseDown((event) => {
        const target = event.target;
        const isGutter = target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN;
        if (!isGutter || !target.position) {
          return;
        }
        const line = target.position.lineNumber;
        if (event.event.rightButton) {
          gutterContextMenu(line, event.event.posx, event.event.posy);
          return;
        }
        void useDebugStore.getState().toggleBreakpoint(path, line);
      });

      const debugActions: Array<{
        id: string;
        label: string;
        keybindings?: number[];
        order: number;
        run: () => void;
      }> = [
        {
          id: 'debug.toggleBreakpoint',
          label: 'Toggle Breakpoint',
          keybindings: [monaco.KeyCode.F9],
          order: 1,
          run: () => {
            const position = editor.getPosition();
            if (position) {
              void useDebugStore.getState().toggleBreakpoint(path, position.lineNumber);
            }
          },
        },
        {
          id: 'debug.addConditionalBreakpoint',
          label: 'Add Conditional Breakpoint…',
          keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.F9],
          order: 2,
          run: () => {
            const position = editor.getPosition();
            if (position) {
              void useDebugStore.getState().addConditionalBreakpoint(path, position.lineNumber);
            }
          },
        },
        {
          id: 'debug.addLogpoint',
          label: 'Add Logpoint…',
          order: 3,
          run: () => {
            const position = editor.getPosition();
            if (position) {
              void useDebugStore.getState().addLogpoint(path, position.lineNumber);
            }
          },
        },
        {
          id: 'debug.runToCursor',
          label: 'Run to Cursor',
          keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.F10],
          order: 4,
          run: () => {
            const position = editor.getPosition();
            if (position) {
              void useDebugStore.getState().runToCursor(path, position.lineNumber);
            }
          },
        },
        {
          id: 'debug.openDisassemblyView',
          label: 'Open Disassembly View',
          order: 5,
          run: () => void useDebugStore.getState().openDisassemblyView(),
        },
      ];

      for (const action of debugActions) {
        editor.addAction({
          id: action.id,
          label: action.label,
          keybindings: action.keybindings,
          contextMenuGroupId: 'debug',
          contextMenuOrder: action.order,
          run: action.run,
        });
      }

      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        void useDebugStore.getState().saveTab(tab.id);
      });
    };

    void (async () => {
      const cached = modelCache.get(path);
      if (cached && !cached.isDisposed()) {
        createEditor(cached);
        setState('ready');
        return;
      }
      try {
        const file = await api.file(path);
        if (cancelled) {
          return;
        }
        if (file.binary) {
          setState('binary');
          return;
        }
        const language = MONACO_LANGUAGE[file.language] ?? 'plaintext';
        const model = monaco.editor.createModel(file.content, language);
        modelCache.set(path, model);
        useDebugStore.getState().updateSourceContent(path, file.content, false);
        createEditor(model);
        setState('ready');
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
          setState('error');
        }
      }
    })();

    return () => {
      cancelled = true;
      const editor = editorRef.current;
      editorRef.current = null;
      if (getActiveEditor() === editor) {
        setActiveEditor(null);
      }
      editor?.dispose();
    };
    // The editor instance is recreated per tab; path is fixed for a tab.
  }, [path, tab.id]);

  // Keep the saved-version baseline in sync when a save happens elsewhere.
  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (!tabDirty && model) {
      savedVersionRef.current = model.getAlternativeVersionId();
    }
  }, [tabDirty]);

  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) {
      return;
    }
    const decorations: monaco.editor.IModelDeltaDecoration[] = [];

    for (const breakpoint of breakpoints) {
      if (breakpoint.temporary) {
        continue;
      }
      const className = !breakpoint.enabled
        ? 'bp-disabled'
        : breakpoint.logMessage
          ? 'bp-log'
          : breakpoint.condition
            ? 'bp-conditional'
            : breakpoint.verified
              ? 'bp-verified'
              : 'bp-unverified';
      decorations.push({
        range: new monaco.Range(breakpoint.line, 1, breakpoint.line, 1),
        options: {
          glyphMarginClassName: className,
          glyphMarginHoverMessage: {
            value: `**${basename(path)}:${breakpoint.line}**${
              breakpoint.condition ? `\n\nCondition: \`${breakpoint.condition}\`` : ''
            }${breakpoint.logMessage ? `\n\nLog: \`${breakpoint.logMessage}\`` : ''}`,
          },
        },
      });
    }

    if (status === 'stopped') {
      const frameLines = new Map<number, boolean>();
      for (const frame of frames) {
        if (frame.sourcePath === path && frame.line > 0) {
          const focused = frame.id === selectedFrameId;
          frameLines.set(frame.line, (frameLines.get(frame.line) ?? false) || focused);
        }
      }
      for (const [line, focused] of frameLines) {
        decorations.push({
          range: new monaco.Range(line, 1, line, 1),
          options: {
            isWholeLine: true,
            className: focused ? 'debug-line-focused' : 'debug-line-other',
            glyphMarginClassName: focused ? 'debug-arrow' : undefined,
          },
        });
      }

    }

    decorationIdsRef.current = editor.deltaDecorations(decorationIdsRef.current, decorations);
  }, [breakpoints, frames, selectedFrameId, status, path, state]);

  // Inline values are rendered as content widgets so they survive scrolling
  // and re-layout exactly where the expression ends.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }
    for (const widget of inlineWidgetsRef.current) {
      editor.removeContentWidget(widget);
    }
    inlineWidgetsRef.current = [];
    if (state !== 'ready' || status !== 'stopped') {
      return;
    }
    for (const value of inlineValues) {
      const node = document.createElement('span');
      node.className = 'inline-value-widget';
      node.textContent = ` = ${truncate(value.value, 60)}`;
      const widget: monaco.editor.IContentWidget = {
        getId: () => `inline-${value.line}-${value.startColumn}`,
        getDomNode: () => node,
        getPosition: () => ({
          position: { lineNumber: value.line, column: value.endColumn },
          preference: [monaco.editor.ContentWidgetPositionPreference.EXACT],
        }),
      };
      editor.addContentWidget(widget);
      inlineWidgetsRef.current.push(widget);
    }
    return () => {
      for (const widget of inlineWidgetsRef.current) {
        editor.removeContentWidget(widget);
      }
      inlineWidgetsRef.current = [];
    };
  }, [inlineValues, status, state]);

  useEffect(() => {
    if (!revealLine || revealLine.path !== path) {
      return;
    }
    const editor = editorRef.current;
    if (!editor) {
      return;
    }
    const line = Math.max(1, revealLine.line);
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: revealLine.column ?? 1 });
    editor.focus();
  }, [revealLine, path, state]);

  return (
    <>
      <div
        className="source-editor"
        ref={containerRef}
        style={{ display: state === 'ready' ? 'block' : 'none' }}
      />
      {state === 'loading' ? (
        <div className="editor-placeholder">
          <Codicon name="loading" spin /> Loading {basename(path)}…
        </div>
      ) : null}
      {state === 'error' ? (
        <div className="editor-placeholder">
          <Codicon name="warning" />
          <div>
            <div>The file could not be opened</div>
            <div className="editor-placeholder-path">{path}</div>
            <div className="editor-placeholder-detail">{error}</div>
            <div className="editor-placeholder-detail">
              If the debugger reported a path that does not exist locally, add a sourceFileMap entry
              to launch.json.
            </div>
          </div>
        </div>
      ) : null}
      {state === 'binary' ? (
        <div className="editor-placeholder">
          <Codicon name="file-binary" />
          <div>
            <div>The file is not displayed in the editor because it is binary.</div>
            <div className="editor-placeholder-path">{path}</div>
          </div>
        </div>
      ) : null}
    </>
  );
}
