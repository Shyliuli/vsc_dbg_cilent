import { api } from '../api.ts';
import type { DapClient } from '../dap/client.ts';
import type { DebugStore } from './types.ts';

/**
 * Module-level runtime handles that must not live in React state.
 */

let activeClient: DapClient | null = null;
let generation = 0;
let idCounter = 0;
const fileTextCache = new Map<string, string>();

export type SetState = (
  partial: Partial<DebugStore> | ((state: DebugStore) => Partial<DebugStore>),
) => void;
export type GetState = () => DebugStore;

export function nextId(prefix: string): string {
  return `${prefix}-${++idCounter}`;
}

export function beginSession(): number {
  generation++;
  return generation;
}

export function currentGeneration(): number {
  return generation;
}

export function endSession(): void {
  generation++;
}

export function setActiveClient(client: DapClient | null): void {
  activeClient = client;
}

export function getActiveClient(): DapClient | null {
  return activeClient;
}

/** Evaluate expressions for inline value hints; the active client is required. */
export function requireClient(): DapClient | null {
  return activeClient;
}

export async function getFileText(path: string): Promise<string | null> {
  const cached = fileTextCache.get(path);
  if (cached !== undefined) {
    return cached;
  }
  try {
    const file = await api.file(path);
    fileTextCache.set(path, file.content);
    return file.content;
  } catch {
    return null;
  }
}

export function setCachedFileText(path: string, text: string): void {
  fileTextCache.set(path, text);
}

export function invalidateFileText(path: string): void {
  fileTextCache.delete(path);
}
