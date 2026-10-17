// @ts-check
/**
 * Renders the memory panel: a 64-byte hex grid, eight bytes per row,
 * highlighting bytes changed by the last step.
 * @module memory
 */

import { hex32 } from './registers.js';

/** Number of bytes shown at once. */
export const WINDOW_SIZE = 64;

/** Bytes per row: two 32-bit words, narrow enough for a phone. */
const ROW_SIZE = 8;

/**
 * Chooses where the window starts so that `focus` sits in its fourth row,
 * with context above and below, aligned to a row and kept inside memory.
 * @param {number} focus Address to show.
 * @param {number} memorySize Total memory in bytes.
 * @returns {number} First address of the window.
 */
export function windowStart(focus, memorySize) {
  const start = Math.floor(focus / ROW_SIZE) * ROW_SIZE - 3 * ROW_SIZE;
  return Math.max(0, Math.min(start, memorySize - WINDOW_SIZE));
}

/**
 * Re-renders the memory grid.
 * @param {HTMLElement} container Element that receives the rows.
 * @param {Uint8Array} bytes Memory contents starting at `start`.
 * @param {number} start Address of `bytes[0]`.
 * @param {Set<number>} changed Addresses changed by the last step.
 */
export function renderMemory(container, bytes, start, changed) {
  const rows = [];
  for (let offset = 0; offset < bytes.length; offset += ROW_SIZE) {
    const row = document.createElement('div');
    row.className = 'memory-row';
    row.setAttribute('role', 'row');
    const address = document.createElement('span');
    address.className = 'addr';
    address.setAttribute('role', 'rowheader');
    address.textContent = hex32(start + offset);
    row.append(address);
    for (let i = offset; i < Math.min(offset + ROW_SIZE, bytes.length); i++) {
      const cell = document.createElement('span');
      cell.setAttribute('role', 'cell');
      cell.textContent = bytes[i].toString(16).padStart(2, '0');
      if (changed.has(start + i)) {
        cell.className = 'byte changed';
        const note = document.createElement('span');
        note.className = 'sr-only';
        note.textContent = ' (changed)';
        cell.append(note);
      } else {
        cell.className = 'byte';
      }
      row.append(cell);
    }
    rows.push(row);
  }
  container.replaceChildren(...rows);
}
