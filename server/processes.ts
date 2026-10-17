import { readdir, readFile, readlink } from 'node:fs/promises';

import type { ProcessInfo } from '../shared/types.ts';

/**
 * List local processes for "Attach to Process".
 *
 * Linux-only, which matches the gdb DAP interpreter's native target support.
 * Kernel threads (empty cmdline) are skipped because they cannot be attached.
 */
export async function listProcesses(): Promise<ProcessInfo[]> {
  const entries = await readdir('/proc', { withFileTypes: true });
  const processes: ProcessInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) {
      continue;
    }
    const pid = Number.parseInt(entry.name, 10);
    if (pid === process.pid) {
      continue;
    }
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      // Field 3 is the state; comm may contain spaces and parentheses.
      const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
      if (state === 'Z' || state === 'X') {
        continue;
      }
      const cmdlineRaw = await readFile(`/proc/${pid}/cmdline`, 'utf8');
      const cmdline = cmdlineRaw.split('\0').filter(Boolean).join(' ').trim();
      if (cmdline.length === 0) {
        continue;
      }
      const comm = await readFile(`/proc/${pid}/comm`, 'utf8').catch(() => '');
      const name = comm.trim() || cmdline.split(' ')[0] || `pid ${pid}`;
      const exe = await readlink(`/proc/${pid}/exe`).catch(() => null);
      processes.push({ pid, name, cmdline: cmdline.slice(0, 300), exe });
    } catch {
      // The process exited while it was being inspected, or is not readable.
      continue;
    }
  }

  processes.sort((a, b) => a.name.localeCompare(b.name) || a.pid - b.pid);
  return processes;
}
