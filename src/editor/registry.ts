import type * as monacoNs from 'monaco-editor';

let activeEditor: monacoNs.editor.IStandaloneCodeEditor | null = null;

export function setActiveEditor(editor: monacoNs.editor.IStandaloneCodeEditor | null): void {
  activeEditor = editor;
}

export function getActiveEditor(): monacoNs.editor.IStandaloneCodeEditor | null {
  return activeEditor;
}
