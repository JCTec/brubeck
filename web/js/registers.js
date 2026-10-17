// @ts-check
/**
 * Renders the register panel: x0..x31 in groups of eight, with ABI names, hex
 * and signed decimal values, highlighting registers changed by the last step.
 * @module registers
 */

import { ABI_NAMES } from './brubeck.js';

/**
 * Formats an unsigned 32-bit value as `0x0000002a`.
 * @param {number} value
 * @returns {string}
 */
export const hex32 = (value) => `0x${(value >>> 0).toString(16).padStart(8, '0')}`;

/**
 * Builds a register row element.
 * @param {number} index
 * @param {number} value
 * @param {boolean} changed
 * @returns {HTMLElement}
 */
function row(index, value, changed) {
  const tr = document.createElement('div');
  tr.className = changed ? 'register-row changed' : 'register-row';
  tr.setAttribute('role', 'row');
  for (const [cls, text] of [
    ['reg', `x${index}`],
    ['abi', ABI_NAMES[index]],
    ['hex', hex32(value)],
    ['dec', `(${value | 0})`],
  ]) {
    const cell = document.createElement('span');
    cell.className = cls;
    cell.setAttribute('role', 'cell');
    cell.textContent = text;
    tr.append(cell);
  }
  return tr;
}

/**
 * Re-renders the register panel.
 * @param {HTMLElement} container Element that receives the four groups of rows.
 * @param {HTMLElement} pcElement Element showing the program counter.
 * @param {number[]} values Current x0..x31 values.
 * @param {number} pc Current program counter.
 * @param {Iterable<number>} [changed] Indices changed by the last step.
 */
export function renderRegisters(container, pcElement, values, pc, changed = []) {
  const changedSet = new Set(changed);
  const groups = [];
  for (let start = 0; start < values.length; start += 8) {
    const group = document.createElement('div');
    group.className = 'register-group';
    group.setAttribute('role', 'rowgroup');
    for (let i = start; i < Math.min(start + 8, values.length); i++) {
      group.append(row(i, values[i], changedSet.has(i)));
    }
    groups.push(group);
  }
  container.replaceChildren(...groups);
  pcElement.textContent = hex32(pc);
}
