// @ts-check
/**
 * Phase 1 smoke test: proves the Rust → WebAssembly → ES module pipeline end
 * to end with a minimal console. The full interface replaces this in Phase 2.
 * @module smoke
 */

import { ABI_NAMES, BrubeckError, Emulator } from './brubeck.js';

/**
 * Looks up a required element by id.
 * @template {HTMLElement} T
 * @param {string} id
 * @param {new () => T} type Expected element class.
 * @returns {T}
 */
function element(id, type) {
  const found = document.getElementById(id);
  if (!(found instanceof type)) throw new Error(`Missing #${id}`);
  return found;
}

const log = element('log', HTMLDivElement);
const form = element('prompt', HTMLFormElement);
const input = element('line', HTMLInputElement);
const regs = element('regs', HTMLDivElement);

/**
 * Formats an unsigned 32-bit value as `0x0000002a`.
 * @param {number} value
 * @returns {string}
 */
const hex = (value) => `0x${(value >>> 0).toString(16).padStart(8, '0')}`;

/**
 * Appends a line to the log.
 * @param {string} text
 * @param {string} [className]
 */
function print(text, className) {
  const line = document.createElement('div');
  line.textContent = text;
  if (className) line.className = className;
  log.append(line);
  log.scrollTop = log.scrollHeight;
}

/**
 * Describes a delta in one line, like the terminal REPL does.
 * @param {import('./brubeck.js').StateDelta} delta
 * @returns {string}
 */
function describe(delta) {
  const parts = delta.registers.map((r) => `x${r.index}: ${r.before} → ${r.after}`);
  if (delta.memory.length) parts.push(`${delta.memory.length} byte(s) of memory`);
  parts.push(`PC: ${hex(delta.pc.before)} → ${hex(delta.pc.after)}`);
  return parts.join(', ');
}

/**
 * Redraws the register grid, highlighting registers changed by `delta`.
 * @param {Emulator} emu
 * @param {import('./brubeck.js').StateDelta} [delta]
 */
function renderRegisters(emu, delta) {
  const changed = new Set(delta?.registers.map((r) => r.index));
  const cells = emu.registers().map((value, index) => {
    const cell = document.createElement('div');
    if (changed.has(index)) cell.className = 'changed';
    const label = document.createElement('b');
    label.textContent = ABI_NAMES[index];
    cell.append(label, hex(value));
    return cell;
  });
  const pc = document.createElement('div');
  const label = document.createElement('b');
  label.textContent = 'pc';
  pc.append(label, hex(emu.pc));
  regs.replaceChildren(...cells, pc);
}

/**
 * Runs one line of input: a slash command or an instruction.
 * @param {Emulator} emu
 * @param {string} line
 */
function run(emu, line) {
  print(`> ${line}`, 'in');
  try {
    /** @type {import('./brubeck.js').StateDelta | undefined} */
    let delta;
    if (line === '/prev' || line === '/p') delta = emu.previous();
    else if (line === '/next' || line === '/n') delta = emu.next();
    else if (line === '/reset') emu.reset();
    else delta = emu.interpret(line);
    print(delta ? describe(delta) : 'Reset.');
    renderRegisters(emu, delta);
  } catch (error) {
    if (!(error instanceof BrubeckError)) throw error;
    print(error.message, 'err');
    if (error.tip) print(error.tip, 'tip');
  }
}

try {
  const emu = await Emulator.create();
  log.replaceChildren();
  print('Brubeck loaded. Running a short demo:');
  for (const line of ['ADDI x1, zero, 100', 'ADD x2, x1, x1', 'LI x3, 0x12345678']) {
    run(emu, line);
  }
  input.disabled = false;
  input.focus();
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const line = input.value.trim();
    if (line) run(emu, line);
    input.value = '';
  });
} catch (error) {
  log.textContent = `Failed to load the emulator: ${error instanceof Error ? error.message : error}`;
  log.className = 'err';
}
