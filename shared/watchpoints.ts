/**
 * gdb's DAP interpreter has no `setDataBreakpoints` request, but gdb itself
 * supports watchpoints. The client maps data breakpoints onto the gdb command
 * language and tracks the breakpoint numbers gdb assigns.
 */

export type WatchpointAccess = 'write' | 'read' | 'readWrite';

export interface WatchpointAccessInfo {
  access: WatchpointAccess;
  label: string;
  description: string;
  command: 'watch' | 'rwatch' | 'awatch';
}

export const WATCHPOINT_ACCESS: Record<WatchpointAccess, WatchpointAccessInfo> = {
  write: {
    access: 'write',
    label: 'Break on Value Change',
    description: 'write watchpoint',
    command: 'watch',
  },
  read: {
    access: 'read',
    label: 'Break on Value Read',
    description: 'read watchpoint',
    command: 'rwatch',
  },
  readWrite: {
    access: 'readWrite',
    label: 'Break on Value Read/Write',
    description: 'read/write watchpoint',
    command: 'awatch',
  },
};

export function watchpointCommand(access: WatchpointAccess, expression: string): string {
  return `${WATCHPOINT_ACCESS[access].command} ${expression.trim()}`;
}

export function watchpointAccessLabel(access: WatchpointAccess): string {
  switch (access) {
    case 'write':
      return 'Write';
    case 'read':
      return 'Read';
    case 'readWrite':
      return 'Read/Write';
  }
}

/**
 * gdb prints e.g. "Hardware watchpoint 2: counter" or
 * "Software watchpoint 1: value". It also prints "Watchpoint 3: ..." for
 * targets that do not distinguish hardware.
 */
export function parseWatchpointNumber(output: string): number | null {
  const match = /watchpoint\s+(\d+)/i.exec(output);
  if (!match) {
    return null;
  }
  const value = Number.parseInt(match[1], 10);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Parse `info watchpoints` as a fallback when the creation output could not be
 * read. Lines look like:
 *   2       hw watchpoint  keep y                      counter
 * The number and the watched expression are the stable parts.
 */
export function parseWatchpointList(output: string, expression: string): number | null {
  const wanted = expression.trim();
  let found: number | null = null;
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+.*watchpoint/i.exec(line);
    if (!match) {
      continue;
    }
    if (line.includes(wanted)) {
      found = Number.parseInt(match[1], 10);
    }
  }
  return found;
}
