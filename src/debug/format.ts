import type { SourceBreakpoint, StopKind } from './types.ts';

export function basename(filePath: string): string {
  const index = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return index === -1 ? filePath : filePath.slice(index + 1);
}

export function dirname(filePath: string): string {
  const index = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return index <= 0 ? '' : filePath.slice(0, index);
}

export function stopKindLabel(kind: StopKind | null): string {
  switch (kind) {
    case 'breakpoint':
      return 'Paused on breakpoint';
    case 'step':
      return 'Paused on step';
    case 'exception':
      return 'Paused on exception';
    case 'pause':
      return 'Paused on pause';
    case 'entry':
      return 'Paused on entry';
    case 'signal':
      return 'Paused on signal';
    case 'data breakpoint':
      return 'Paused on data breakpoint';
    default:
      return 'Paused';
  }
}

export function breakpointDetail(breakpoint: SourceBreakpoint): string | null {
  if (breakpoint.logMessage) {
    return `log: ${breakpoint.logMessage}`;
  }
  if (breakpoint.condition) {
    return `condition: ${breakpoint.condition}`;
  }
  return null;
}

export function breakpointIcon(breakpoint: SourceBreakpoint): string {
  if (breakpoint.temporary) {
    return 'debug-breakpoint';
  }
  if (breakpoint.logMessage) {
    return 'debug-breakpoint-log';
  }
  if (breakpoint.condition) {
    return 'debug-breakpoint-conditional';
  }
  if (!breakpoint.verified) {
    return 'debug-breakpoint-unverified';
  }
  return 'debug-breakpoint';
}

/** Parse "key=value" style quick input without surprises. */
export function trimmedOrUndefined(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

const LANGUAGE_LABELS: Record<string, string> = {
  '.c': 'C',
  '.h': 'C',
  '.cpp': 'C++',
  '.cc': 'C++',
  '.cxx': 'C++',
  '.hpp': 'C++',
  '.hh': 'C++',
  '.json': 'JSON',
  '.jsonc': 'JSON with Comments',
  '.md': 'Markdown',
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.py': 'Python',
  '.sh': 'Shell Script',
  '.S': 'Assembly',
  '.s': 'Assembly',
  '.rs': 'Rust',
  '.go': 'Go',
  '.txt': 'Plain Text',
};

export function languageLabelForPath(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  if (dot <= slash) {
    return 'Plain Text';
  }
  return LANGUAGE_LABELS[filePath.slice(dot)] ?? 'Plain Text';
}

export function fileExtension(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return dot <= slash ? '' : filePath.slice(dot + 1).toLowerCase();
}
