"""Allocate a pty and bridge it to stdin/stdout/control pipes.

Protocol (all on the helper's stdio, set up by server/ptyBridge.ts):
  stdout line 1: the pty slave path (e.g. /dev/pts/3), then raw pty output
  stdin:    raw bytes written to the pty master (keyboard input)
  fd 3:     control lines, e.g. "RESIZE <cols> <rows>"
  stderr:   diagnostics

The pty slave stays open here so gdb can attach the inferior with
`set inferior-tty <path>` without the terminal disappearing between opens.
"""

import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios

DEFAULT_COLS = int(os.environ.get("PTY_COLS", "100"))
DEFAULT_ROWS = int(os.environ.get("PTY_ROWS", "30"))

master, slave = pty.openpty()


def set_winsize(columns: int, line_count: int) -> None:
    fcntl.ioctl(
        slave,
        termios.TIOCSWINSZ,
        struct.pack("HHHH", line_count, columns, 0, 0),
    )


set_winsize(DEFAULT_COLS, DEFAULT_ROWS)

out_fd = sys.stdout.fileno()
in_fd = sys.stdin.fileno()
control_fd = 3


def terminate(_signum, _frame) -> None:
    os.close(master)
    sys.exit(0)


signal.signal(signal.SIGTERM, terminate)
signal.signal(signal.SIGINT, terminate)

sys.stdout.write(os.ttyname(slave) + "\n")
sys.stdout.flush()

while True:
    try:
        readable, _, _ = select.select([master, in_fd, control_fd], [], [])
    except InterruptedError:
        continue
    except OSError:
        break

    if master in readable:
        try:
            data = os.read(master, 65536)
        except OSError as exc:
            if exc.errno == errno.EIO:
                break
            raise
        if not data:
            break
        os.write(out_fd, data)

    if in_fd in readable:
        data = os.read(in_fd, 65536)
        if not data:
            break
        os.write(master, data)

    if control_fd in readable:
        data = os.read(control_fd, 4096)
        if not data:
            break
        for line in data.decode("utf-8", "replace").splitlines():
            parts = line.split()
            if len(parts) == 3 and parts[0] == "RESIZE":
                set_winsize(int(parts[1]), int(parts[2]))
