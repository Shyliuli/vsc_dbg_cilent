import React from 'react';
import ReactDOM from 'react-dom/client';

import '@vscode/codicons/dist/codicon.css';
import '@xterm/xterm/css/xterm.css';
import './styles/theme.css';
import './styles/app.css';

import { App } from './App.tsx';
import { useDebugStore } from './debug/store.ts';
import { registerHoverProvider } from './editor/hover.ts';
import { monaco } from './editor/monaco.ts';

registerHoverProvider();

if (import.meta.env.DEV) {
  // Automation/debug hooks for the dev server; not shipped in the build.
  (window as unknown as { __gdbClientStore?: unknown }).__gdbClientStore = useDebugStore;
  (window as unknown as { __gdbClientMonaco?: unknown }).__gdbClientMonaco = monaco;
}

const container = document.getElementById('root');
if (!container) {
  throw new Error('root element is missing from index.html');
}

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
