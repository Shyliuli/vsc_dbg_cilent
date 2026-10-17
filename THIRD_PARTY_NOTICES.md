# Third-party notices

This project is built on the following open-source components. Their full
license texts are shipped inside the corresponding `node_modules` packages.

## Front-end runtime components

- **Monaco Editor** 0.55.1 — MIT — Copyright (c) Microsoft Corporation.
  <https://github.com/microsoft/monaco-editor>
- **@vscode/codicons** 0.0.44 — **CC-BY-4.0** — Copyright (c) Microsoft
  Corporation. The icon font and CSS are used under the Creative Commons
  Attribution 4.0 license; attribution is provided here and in the README.
  <https://github.com/microsoft/vscode-codicons>
- **@vscode/debugprotocol** 1.68.0 — MIT — Copyright (c) Microsoft Corporation.
  Type declarations for the Debug Adapter Protocol only.
- **jsonc-parser** 3.3.1 — MIT — Copyright (c) Microsoft Corporation.
- **@xterm/xterm** 5.5.0 and **@xterm/addon-fit** 0.10.0 — MIT — Copyright (c)
  The xterm.js authors.
- **React** / **React DOM** 19 — MIT — Copyright (c) Meta Platforms, Inc.
- **zustand** 5 — MIT — Copyright (c) 2019 Paul Henschel.
- **ws** 8 — MIT — Copyright (c) 2011 Einar Otto Stangvik.

## Build-time components

- **Vite** 7 — MIT.
- **TypeScript** 5.9 — Apache-2.0.
- **@vitejs/plugin-react** — MIT.
- **esbuild** — MIT.

## External programs (not bundled)

- **gdb** (tested with GNU gdb 17.2) — GPLv3.
  gdb is not linked or redistributed by this project. It is invoked as a
  separate program with `--interpreter=dap`, and gdb's own DAP implementation
  (Python, part of gdb) acts as the debug adapter. If you redistribute a package
  that includes gdb, that distribution must comply with GPLv3.
- **python3** — PSF license. Used by `server/pty_helper.py` to allocate a pty
  for the integrated terminal.
