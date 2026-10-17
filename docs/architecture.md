# Architecture

## Why gdb is the adapter

VS Code's C++ debugging normally goes through cpptools, which drives gdb in MI
mode and translates MI to DAP. That translation layer is where most subtle
behavior lives: deferred launch, breakpoint relocation events, reference
lifetimes, paging, hit counts, exception catchpoints.

gdb 14+ ships its own DAP interpreter (`gdb --interpreter=dap`). Using it means:

- the protocol semantics are gdb's, not a reimplementation;
- the capability set reported to the UI is authoritative;
- the backend stays small enough to audit (spawn, frame, forward, trace).

The front end is therefore a genuine DAP client, not an approximation.

## Process and transport model

```
browser (React + Monaco)
   │  DAP JSON over WebSocket (one object per message)
   ▼
Node server (server/main.ts)
   │  spawn per WebSocket: gdb --interpreter=dap --quiet [program]
   │  Content-Length framed DAP JSON over stdin/stdout
   ▼
gdb DAP interpreter
   │  Python implementation in gdb/python/lib/gdb/dap
   ▼
inferior process (in its own process group)
```

- One WebSocket equals one gdb session. Closing the socket disposes the gdb
  process group, so a refresh or crash never leaks debuggees.
- The bridge forwards DAP payloads verbatim. It adds only `control` messages
  (`started`, `error`, `gdbStderr`, `gdbExited`, `trace`) that are not part of
  DAP; the client ignores them for protocol purposes.
- `control: "start"` is sent before DAP `initialize` and carries the gdb path,
  extra gdb arguments, the program (loaded via argv so `setupCommands` can see
  symbols) and the working directory. Paths are validated server-side; failures
  are reported as control errors before a session exists.
- The bridge keeps a bounded in-memory trace of client/adapter messages,
  exposed by the Output panel's "Show DAP Trace" action. No log files are
  written into the workspace.

## Session lifecycle

```
client                                   gdb
  │ control start (program)               │
  │───────────────────────────────────────▶ spawn
  │◀───────────────── control started ─────│
  │ initialize (client capabilities)       │
  │───────────────────────────────────────▶
  │◀────────────────── initialized ────────│
  │ launch/attach (deferred by gdb)        │
  │───────────────────────────────────────▶
  │ evaluate "set confirm off" (repl)      │
  │ evaluate setupCommands (repl)          │
  │ setBreakpoints / setFunctionBreakpoints│
  │ setInstructionBreakpoints              │
  │ setExceptionBreakpoints                │
  │───────────────────────────────────────▶
  │ configurationDone                      │
  │───────────────────────────────────────▶  run
  │◀─────────────── launch response ───────│ (deferred until now)
  │◀─────────────── stopped / exited ──────│
```

gdb defers `launch`/`attach` until `configurationDone`, so breakpoints are
installed before the inferior starts. The client does not wait for the launch
response before sending `configurationDone`; it awaits it afterwards so launch
errors still surface.

`restart` is client-side: `disconnect(terminateDebuggee: true)`, then a new
session with the same configuration. Breakpoints, watch expressions and the
selected configuration are preserved; the debug console is reset.

## Client capabilities and why

| Capability | Value | Reason |
| --- | --- | --- |
| `supportsVariableType` | true | show C/C++ types next to values, as VS Code does |
| `supportsVariablePaging` | true | registers (146 on LoongArch) and large containers page at 100 items |
| `supportsMemoryReferences` | true | pointer variables get a `memoryReference`, enabling "View Memory" |
| `linesStartAt1`, `columnsStartAt1` | true | DAP lines/columns are 1-based throughout the UI |
| `pathFormat` | `path` | absolute Unix paths from gdb |
| `supportsRunInTerminalRequest` | false | the UI has no terminal; gdb must not ask for one |
| `supportsProgressReporting` | false | gdb emits no progress events |

gdb's `initialize` response drives the rest: conditional/hit/log breakpoints,
function and instruction breakpoints, exception filters (including Ada and all
three C++ exception events), `readMemory`/`writeMemory`, `disassemble`,
`setVariable`/`setExpression`, `completions`, `breakpointLocations`, and
delayed stack traces.

## Breakpoint bookkeeping

The UI owns breakpoint identity; gdb's numeric ids arrive in responses and
`breakpoint` events and are stored as `adapterId`.

- `setBreakpoints` is idempotent per file: the client sends the full enabled
  list for that file, and maps responses back by array index (gdb preserves
  order).
- Disabled breakpoints stay in the UI but are omitted from the request; enabling
  one re-sends the file's list.
- `breakpoint` events with `changed` are matched by `adapterId` and update
  verification/line/address. Unknown ids (for example catchpoints created by
  `setExceptionBreakpoints`) are ignored by the source-breakpoint path.
- Run to cursor adds a hidden `temporary` breakpoint, syncs, continues, and
  removes it on the next stop.
- Hit counts are passed through as `hitCondition`; gdb interprets the value as
  its ignore count (`ignore_count = int(hitCondition)`), so `2` stops on the
  third hit. This matches gdb's DAP mapping, not an idealized "hit number".
- Exception filters: filters without a condition go in `filters`, filters with
  one go in `filterOptions` (gdb would create duplicate catchpoints otherwise).
  The response order is filters first, then filterOptions.

## References, scopes and paging

gdb's `variablesReference` values are valid only for the current pause. The
store keeps `variables[ref] -> { nodes, start, hasMore }` keyed by the reference
and clears it on continue and on frame changes, matching the DAP lifetime rules.

- Scopes with hints `locals`, `arguments` and `returnValue` expand
  automatically; `registers` and `globals` expand on demand.
- Each child is fetched with `start`/`count` and appended; `hasMore` is true while
  a full page arrives. gdb reports the real child count in `namedVariables` /
  `indexedVariables`, which is used for the `{…}` / `[…]` placeholder.
- Every node carries the expression path that produced it (`values[i].x`,
  `$r3`, …) so "Add to Watch" and "Copy as Expression" work for nested values.
- `setVariable` re-fetches the parent container after writing, so sibling values
  and pretty-printed output stay consistent.

## Inline values and hovers

- Hover evaluation uses `context: "hover"`; gdb disables register/memory writes
  and inferior calls for that context and returns a value plus its type. Monaco
  renders it as a markdown hover.
- Inline values are computed only for the selected frame's source line: the
  local/argument/global names already loaded from scopes are matched against
  member/index chains on that line, then evaluated with the same hover context.
  Identifiers inside comments and string literals are masked out.
- Monaco content widgets render the values (the `after` injected-text decoration
  path was not reliable in Monaco 0.55), so labels stay anchored while scrolling.

## Data breakpoints (watchpoints)

gdb's DAP interpreter does not implement `setDataBreakpoints` and does not
advertise `supportsDataBreakpoints`, so the standard request cannot be used. gdb
itself still has watchpoints, so the client maps the feature:

| UI action | gdb command | Stop reason |
| --- | --- | --- |
| Break on Value Change | `watch <expr>` | `data breakpoint` |
| Break on Value Read | `rwatch <expr>` | `data breakpoint` |
| Break on Value Read/Write | `awatch <expr>` | `data breakpoint` |

How the mapping works:

- Data breakpoints are created through the DAP `evaluate` repl channel while the
  program is paused. gdb resolves the expression in the selected frame, which is
  why add/remove/enable/disable require a stopped program.
- gdb prints `Hardware watchpoint 2: counter` (or `Software watchpoint …`); the
  client parses the number, and falls back to `info watchpoints` if the creation
  output is not informative.
- Removal and disabling issue `delete <n>`. Re-enabling re-creates the watchpoint
  and refreshes its number.
- On stop, the client matches `hitBreakpointIds` against `adapterId`. gdb does
  not always include watchpoints in `hitBreakpointIds`; when the stop reason is
  `data breakpoint` and exactly one data breakpoint is active, that breakpoint is
  attributed unambiguously.
- Data breakpoints live for the session only and are cleared on stop/restart/
  inferior exit. Hardware watchpoint capacity is a CPU/target limit; gdb may use
  software watchpoints otherwise. Conditions and hit counts are not exposed.

This keeps the UI behavior close to cpptools' "Break on Value Change" without
modifying gdb or pretending the DAP request exists.

## Integrated terminal and program stdin

gdb's DAP interpreter rewires the inferior's stdin to `/dev/null`, which is fine
for batch programs but makes interactive programs impossible. VS Code solves this
the same way cpptools does: with `"console": "integratedTerminal"`, the adapter
allocates a terminal and the program's stdio is attached to it.

gdb-client implements that path without patching gdb:

```
control start({ terminal: {cols, rows} })
  └─ PtyBridge.create()
       └─ python3 -u server/pty_helper.py
            ├─ stdout: "<slave path>\n" then raw pty output
            ├─ stdin:  raw bytes → pty master
            └─ fd 3:   "RESIZE <cols> <rows>" control lines
control started({ terminal: { slave: "/dev/pts/N" } })
client sends setup command:  set inferior-tty /dev/pts/N
configurationDone → gdb runs the inferior with that tty
```

- The helper keeps the slave fd open so gdb can open the path itself; the
  master side is bridged to the browser.
- Terminal traffic rides the existing DAP WebSocket as `control` messages:
  `terminalData` (base64), `terminalInput` (base64), `terminalResize`,
  `terminalExit`, `terminalError`. No extra port or auth token is needed, and
  cross-origin protection is already enforced at the socket handshake.
- The front end renders the terminal with xterm.js in the panel. Output chunks
  are batched (16 ms) before hitting the store; the component writes only the
  new chunks to xterm. When the chunk buffer is truncated, an epoch counter
  resets the terminal instead of replaying stale bytes.
- `set inferior-tty` is sent before the configuration's own `setupCommands`, so
  a configuration can override it deliberately.
- With an integrated terminal, the inferior's stdout/stderr go to the pty, not
  to DAP `output` events. That matches VS Code's integratedTerminal mode: gdb's
  own messages (symbol loading, breakpoint placement) stay in the Debug Console.
- Attach sessions cannot rewire an already-running process, so the
  configuration is normalized to `internalConsole` with a warning.
- The pty helper is disposed when gdb exits or the WebSocket closes; gdb itself
  is the process-group leader, so no debuggee is left behind.

## Disassembly and memory

- `disassemble` requires a numeric address. The view resolves the selected
  frame's function start by evaluating `(void*)'<frame.name>'` and falls back to
  the frame's instruction pointer. Negative `instructionOffset` is not honored
  by gdb's implementation, so paging is done by computing the next address from
  the last instruction's byte length.
- Instruction breakpoints go through `setInstructionBreakpoints`; gdb maps them
  to address breakpoints and reports the source location when it can.
- Memory view uses `readMemory` (256 bytes per page) and renders 16 bytes per
  row with an ASCII column. Address inputs accept hex, decimal, or an expression
  evaluated in the selected frame.

## Error handling

- Transport/spawn failures arrive as control `error` messages and surface as a
  toast plus a Debug Console line; the session transitions to `error` or
  `inactive` instead of pretending to run.
- DAP request failures reject with the adapter's message (`notStopped` while the
  inferior runs, gdb errors for invalid expressions, etc.).
- Variable/scope fetch failures are shown inline in the tree; they never clear
  valid state silently.
- Missing source files show a placeholder that points at `sourceFileMap`.
- Breakpoint sync failures keep the breakpoint in the list, mark it unverified,
  and raise an error notification with the adapter's message.

## Verification

Automated:

```console
npm run typecheck   # tsc for web and server, strict
npm test            # 26 tests: framing, launch.json, watchpoints, end-to-end DAP
```

The end-to-end test exercises a real gdb session over the WebSocket bridge:
launch, conditional breakpoints, logpoints, exception catchpoints, function
breakpoints, hit counts, step in/out/over, stack/scopes/variables with paging,
registers, `setVariable`, hover evaluate, `disassemble`, `readMemory`, exit,
disconnect, attach to a live process, the integrated terminal (allocates a pty,
points gdb at it with `set inferior-tty`, feeds `world\n` and `5\n`, asserts
`hello world, doubled=10`), and data breakpoints (creates `watch counter`, waits
for a `data breakpoint` stop, deletes the watchpoint through the UI command).

Manual (browser, `http://localhost:5173` during development):

- launch → stop at entry → variables/scopes/call stack populated;
- F9 + F5 stops at a source breakpoint, editor reveals the line, gutter shows
  the breakpoint and current-instruction arrow, inline values appear;
- stepping updates frames, inline values, and watch values;
- hover over `total` shows `total: int = …`;
- conditional breakpoint with `id == 2` stops in the worker thread; the thread
  dropdown lists both threads;
- logpoint prints `loop i=… total=…` lines in the Debug Console;
- `p n*2` in the Debug Console prints `$1 = 12`;
- disassembly view follows the PC and links source lines;
- memory view renders `$sp` bytes and address expressions;
- exception filter "C++ exceptions, when thrown" stops in `__cxa_throw`;
- restart relaunches and re-applies state; stop returns to the start UI;
- launch.json editor saves and refreshes the configuration list;
- `stdio-echo: terminal input` opens the Terminal panel; typing `world` and `5`
  in xterm yields `hello world, doubled=10` and the process exits with code 0;
- "Break on Value Change" on `counter` stops in the worker with "Paused on data
  breakpoint: counter"; the breakpoint row is highlighted; removing it issues
  `delete` and the program can continue to exit.
