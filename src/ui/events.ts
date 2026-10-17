/** Cross-component UI events that are not worth putting in the debug store. */

export const OPEN_COMMAND_PALETTE_EVENT = 'gdb-client:open-command-palette';

export function openCommandPalette(): void {
  window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE_EVENT));
}
