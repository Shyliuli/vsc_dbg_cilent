import { useEffect, useRef, type ReactNode } from 'react';
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser';

import { runCommand } from '../commands.ts';
import { useDebugStore } from '../debug/store.ts';
import type { EditorTab } from '../debug/types.ts';
import { monaco } from '../editor/monaco.ts';
import { Codicon } from './Icons.tsx';

export function LaunchJsonEditor(props: { tab: EditorTab }): ReactNode {
  const { tab } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<monaco.editor.ITextModel | null>(null);
  const initialContentRef = useRef(tab.launchContent ?? '');
  const content = tab.launchContent ?? '';
  const saveTab = useDebugStore((state) => state.saveTab);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const model = monaco.editor.createModel(initialContentRef.current, 'json');
    modelRef.current = model;
    const editor = monaco.editor.create(container, {
      model,
      theme: 'gdb-client-dark',
      fontFamily: "'DejaVu Sans Mono', 'Droid Sans Mono', 'Liberation Mono', monospace",
      fontSize: 14,
      lineHeight: 19,
      minimap: { enabled: true, renderCharacters: false },
      automaticLayout: true,
      glyphMargin: false,
      folding: true,
      renderLineHighlight: 'line',
      scrollBeyondLastLine: false,
      tabSize: 2,
      padding: { top: 8 },
      scrollbar: { verticalScrollbarSize: 12, horizontalScrollbarSize: 12, useShadows: false },
    });
    editorRef.current = editor;

    const updateMarkers = () => {
      const parseErrors: ParseError[] = [];
      parse(model.getValue(), parseErrors, { allowTrailingComma: true });
      monaco.editor.setModelMarkers(
        model,
        'launch-json',
        parseErrors.map((error) => {
          const position = model.getPositionAt(error.offset);
          return {
            severity: monaco.MarkerSeverity.Error,
            message: printParseErrorCode(error.error),
            startLineNumber: position.lineNumber,
            startColumn: position.column,
            endLineNumber: position.lineNumber,
            endColumn: position.column + Math.max(1, error.length),
          };
        }),
      );
    };
    updateMarkers();

    editor.onDidChangeModelContent(() => {
      const value = model.getValue();
      useDebugStore.getState().updateLaunchContent(tab.id, value);
      updateMarkers();
    });

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void useDebugStore.getState().saveTab(tab.id);
    });

    return () => {
      editor.dispose();
      model.dispose();
      editorRef.current = null;
      modelRef.current = null;
    };
  }, [tab.id]);

  // External content updates come from "Add Configuration".
  useEffect(() => {
    const model = modelRef.current;
    if (model && model.getValue() !== content) {
      model.setValue(content);
    }
  }, [content]);

  const dirty = tab.dirty;

  return (
    <div className="launch-editor">
      <div className="launch-editor-bar">
        <span className="launch-editor-title">
          <Codicon name="gear" /> launch.json
        </span>
        <span className="launch-editor-hint">
          {dirty ? 'Unsaved changes — press Ctrl+S to save' : 'Debug configuration file'}
        </span>
        <button className="link" onClick={() => void saveTab(tab.id)} disabled={!dirty}>
          Save
        </button>
      </div>
      <div className="launch-editor-body" ref={containerRef} />
      <button className="launch-add-configuration" onClick={() => runCommand('debug.addConfiguration')}>
        Add Configuration…
      </button>
    </div>
  );
}
