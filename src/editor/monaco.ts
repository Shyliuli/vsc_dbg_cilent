import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';

/**
 * Monaco is VS Code's editor; using the real thing is what makes the editing
 * surface faithful (glyph margin, hover, decorations, context menu).
 */

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'json') {
      return new jsonWorker();
    }
    return new editorWorker();
  },
};

// JSON validation is performed with jsonc-parser in the launch.json editor so
// comments and trailing commas behave exactly like VS Code. Monaco's generated
// typings keep the json defaults out of the main entry point, so reach into the
// runtime namespace that the JSON language contribution registers.
const jsonDefaults = (
  monaco.languages as unknown as {
    json?: {
      jsonDefaults?: { setDiagnosticsOptions(options: Record<string, unknown>): void };
    };
  }
).json?.jsonDefaults;
jsonDefaults?.setDiagnosticsOptions({
  validate: false,
  allowComments: true,
  trailingCommas: 'ignore',
  schemas: [],
});

monaco.editor.defineTheme('gdb-client-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '6A9955' },
    { token: 'keyword', foreground: '569CD6' },
    { token: 'keyword.control', foreground: 'C586C0' },
    { token: 'string', foreground: 'CE9178' },
    { token: 'number', foreground: 'B5CEA8' },
    { token: 'type', foreground: '4EC9B0' },
    { token: 'type.identifier', foreground: '4EC9B0' },
    { token: 'identifier', foreground: '9CDCFE' },
    { token: 'delimiter', foreground: 'D4D4D4' },
    { token: 'operator', foreground: 'D4D4D4' },
    { token: 'predefined', foreground: '4EC9B0' },
    { token: 'key', foreground: '9CDCFE' },
  ],
  colors: {
    'editor.background': '#1F1F1F',
    'editor.foreground': '#CCCCCC',
    'editor.lineHighlightBackground': '#2A2D2E',
    'editor.lineHighlightBorder': '#00000000',
    'editor.selectionBackground': '#264F78',
    'editor.inactiveSelectionBackground': '#3A3D41',
    'editorCursor.foreground': '#AEAFAD',
    'editorLineNumber.foreground': '#6E7681',
    'editorLineNumber.activeForeground': '#CCCCCC',
    'editorIndentGuide.background1': '#404040',
    'editorIndentGuide.activeBackground1': '#707070',
    'editorGutter.background': '#1F1F1F',
    'editorWidget.background': '#202020',
    'editorWidget.border': '#454545',
    'editorSuggestWidget.background': '#202020',
    'editorHoverWidget.background': '#202020',
    'editorHoverWidget.border': '#454545',
    'editor.findMatchBackground': '#9E6A03',
    'editor.findMatchHighlightBackground': '#EA5C0055',
    'editor.rangeHighlightBackground': '#FFFFFF0B',
    'editorBracketMatch.background': '#0064001A',
    'editorBracketMatch.border': '#888888',
    'scrollbar.shadow': '#00000000',
    'scrollbarSlider.background': '#79797966',
    'scrollbarSlider.hoverBackground': '#646464B3',
    'scrollbarSlider.activeBackground': '#BFBFBF66',
    'minimap.background': '#1F1F1F',
  },
});

monaco.editor.setTheme('gdb-client-dark');

export { monaco };
