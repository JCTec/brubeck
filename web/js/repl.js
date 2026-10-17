// @ts-check
/**
 * The REPL: a terminal-style log and prompt that runs assembly and the same
 * slash commands as the terminal version of Brubeck (`/regs`, `/memory`,
 * `/p`, `/n`, `/reset`, `/help`), plus `/clear`.
 * @module repl
 */

import { ABI_NAMES, BrubeckError } from './brubeck.js';
import { hex32 } from './registers.js';

/** @typedef {import('./brubeck.js').Emulator} Emulator */
/** @typedef {import('./brubeck.js').StateDelta} StateDelta */

/**
 * What a line of input did, reported to the owner after every run.
 * @typedef {Object} StepEvent
 * @property {'instruction' | 'previous' | 'next' | 'reset' | 'inspect' | 'clear' | 'error' | 'crashed'} kind
 * @property {string} token Upper-cased mnemonic or canonical command, e.g. `"ADDI"`, `"/P"`.
 * @property {string} line The line as typed.
 * @property {StateDelta} [delta] State changes, for instructions and history moves.
 */

/**
 * Receives a {@link StepEvent} after every line is run.
 * @callback StepHandler
 * @param {StepEvent} event
 * @returns {void}
 */

/**
 * @typedef {Object} ReplElements
 * @property {HTMLElement} log
 * @property {HTMLFormElement} form
 * @property {HTMLInputElement} input
 * @property {HTMLElement} promptPc
 */

/** @typedef {'/HELP' | '/REGS' | '/MEMORY' | '/P' | '/N' | '/RESET' | '/CLEAR'} CommandName */

/**
 * Canonical names for slash-command aliases.
 * @type {Readonly<Record<string, CommandName>>}
 */
const COMMANDS = Object.freeze({
  '/H': '/HELP', '/HELP': '/HELP',
  '/R': '/REGS', '/REGS': '/REGS',
  '/M': '/MEMORY', '/MEMORY': '/MEMORY',
  '/P': '/P', '/PREV': '/P', '/PREVIOUS': '/P',
  '/N': '/N', '/NEXT': '/N',
  '/RESET': '/RESET',
  '/CLEAR': '/CLEAR',
});

const HELP = `Commands:
  <instruction>      run it, e.g. ADDI x1, zero, 10
  /r, /regs          show all registers
  /r x1 sp ...       show specific registers
  /m, /memory        show 64 bytes around the PC
  /m <addr>          show 64 bytes at an address
  /m <start> <end>   show a range (max 256 bytes)
  /p, /prev          step back in history
  /n, /next          step forward in history
  /reset             clear registers, memory and history
  /clear             clear this log
Up/Down arrows recall earlier lines.`;

/**
 * Parses a register name (`x5`, `t0`, `zero`, `fp`) into its index.
 * @param {string} name
 * @returns {number | null}
 */
export function parseRegister(name) {
  const lower = name.toLowerCase();
  const numbered = /^x(\d{1,2})$/.exec(lower);
  if (numbered) {
    const index = Number(numbered[1]);
    return index < 32 ? index : null;
  }
  if (lower === 'fp') return 8;
  const abi = ABI_NAMES.indexOf(lower);
  return abi >= 0 ? abi : null;
}

/** Instructions whose first operand is a source, not a destination. */
const NO_DESTINATION = new Set(['SB', 'SH', 'SW', 'BEQ', 'BNE', 'BLT', 'BGE', 'BLTU', 'BGEU',
  'J', 'JR', 'RET', 'NOP', 'FENCE', 'ECALL', 'EBREAK']);

/**
 * The register an instruction writes, e.g. 3 for `ADD x3, x1, x2`, or null.
 * @param {string} line
 * @returns {number | null}
 */
export function destinationRegister(line) {
  const [mnemonic, first] = line.trim().split(/[\s,()]+/);
  if (!mnemonic || !first || NO_DESTINATION.has(mnemonic.toUpperCase())) return null;
  const index = parseRegister(first);
  return index === 0 ? null : index; // writes to x0 are discarded
}

/**
 * Parses a decimal or `0x` hexadecimal address.
 * @param {string} text
 * @returns {number | null}
 */
export function parseAddress(text) {
  const value = /^0x[0-9a-f]+$/i.test(text) ? Number.parseInt(text, 16)
    : /^\d+$/.test(text) ? Number(text) : Number.NaN;
  return Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff ? value : null;
}

/**
 * Summarizes a delta in one line, matching the terminal REPL's wording.
 * @param {StateDelta} delta
 * @returns {string}
 */
export function describeDelta(delta) {
  const parts = delta.registers.map((r) => `x${r.index}: ${r.before | 0} → ${r.after | 0}`);
  if (delta.memory.length) parts.push(`${delta.memory.length} memory bytes changed`);
  for (const c of delta.csrs) {
    parts.push(`CSR[0x${c.address.toString(16).padStart(3, '0')}]: ${hex32(c.before)} → ${hex32(c.after)}`);
  }
  if (delta.pc.before !== delta.pc.after) {
    parts.push(`PC: ${hex32(delta.pc.before)} → ${hex32(delta.pc.after)}`);
  }
  return parts.length ? parts.join(', ') : 'No state changes';
}

/**
 * Renders a classic hex dump: 16 bytes per row with an ASCII column.
 * @param {Uint8Array} bytes
 * @param {number} start Address of `bytes[0]`.
 * @returns {string}
 */
function hexDump(bytes, start) {
  const lines = ['Address    00 01 02 03 04 05 06 07 | 08 09 0A 0B 0C 0D 0E 0F  ASCII'];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const row = bytes.subarray(offset, offset + 16);
    const hexes = Array.from(row, (b) => b.toString(16).padStart(2, '0'));
    while (hexes.length < 16) hexes.push('  ');
    const ascii = Array.from(row, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${hex32(start + offset)} ${hexes.slice(0, 8).join(' ')} | ${hexes.slice(8).join(' ')}  ${ascii}`);
  }
  return lines.join('\n');
}

/** Drives the terminal half of the REPL pane. */
export class Repl {
  /** @type {Emulator} */ #emu;
  /** @type {ReplElements} */ #el;
  /** @type {StepHandler} */ #onStep;
  /** @type {string[]} */ #lines = [];
  #cursor = 0;

  /**
   * @param {Emulator} emulator
   * @param {ReplElements} elements
   * @param {StepHandler} onStep Called after every line is run.
   */
  constructor(emulator, elements, onStep) {
    this.#emu = emulator;
    this.#el = elements;
    this.#onStep = onStep;

    elements.form.addEventListener('submit', (event) => {
      event.preventDefault();
      const line = elements.input.value.trim();
      elements.input.value = '';
      if (line) this.run(line);
    });
    elements.input.addEventListener('keydown', (event) => this.#recall(event));
    this.updatePrompt();
  }

  /**
   * Arrow-key recall of earlier lines.
   * @param {KeyboardEvent} event
   */
  #recall(event) {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    if (!this.#lines.length) return;
    event.preventDefault();
    this.#cursor = event.key === 'ArrowUp'
      ? Math.max(0, this.#cursor - 1)
      : Math.min(this.#lines.length, this.#cursor + 1);
    this.#el.input.value = this.#lines[this.#cursor] ?? '';
  }

  /**
   * Replaces the emulator, e.g. after the previous one crashed.
   * @param {Emulator} emulator
   */
  setEmulator(emulator) {
    this.#emu = emulator;
    this.updatePrompt();
  }

  /** The prompt text, `[0x…]>`, or `[crashed]>` if the emulator is unusable. */
  #promptText() {
    try {
      return `[${hex32(this.#emu.pc)}]>`;
    } catch {
      return '[crashed]>';
    }
  }

  /** Shows the current PC in the prompt. */
  updatePrompt() {
    this.#el.promptPc.textContent = this.#promptText();
  }

  /**
   * Appends a line to the log.
   * @param {string} text
   * @param {string} [className]
   * @returns {HTMLElement}
   */
  print(text, className) {
    const line = document.createElement('div');
    if (className) line.className = className;
    line.textContent = text;
    this.#el.log.append(line);
    this.#scrollToEnd();
    return line;
  }

  /** Keeps the prompt in view: the terminal scrolls as one unit with the log. */
  #scrollToEnd() {
    const scroller = this.#el.log.parentElement ?? this.#el.log;
    scroller.scrollTop = scroller.scrollHeight;
  }

  /**
   * Prints a section banner, e.g. `── Step 01 · Put a number in a register ──`.
   * @param {string} text
   */
  banner(text) {
    this.print(`── ${text} ──`, 'banner');
  }

  /** Empties the log. */
  clear() {
    this.#el.log.replaceChildren();
  }

  /**
   * Puts `text` in the prompt without running it, and focuses the input.
   * @param {string} text
   */
  paste(text) {
    this.#el.input.value = text;
    this.#el.input.focus({ preventScroll: true });
    // On narrow screens the REPL sits below the lesson; bring the prompt into view.
    this.#el.input.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /**
   * Logs a history move made outside the prompt (the timeline scrubber) and
   * reports it like `/p` or `/n`, so challenges treat it the same way.
   * @param {StateDelta} delta Net change of the whole move.
   * @param {number} from History position before the move.
   * @param {number} to History position after it.
   */
  reportMove(delta, from, to) {
    const { length } = this.#emu.history;
    this.print(`Moved to ${to} / ${length}: ${describeDelta(delta)}`, 'ok');
    this.updatePrompt();
    const back = to < from;
    this.#onStep({ kind: back ? 'previous' : 'next', token: back ? '/P' : '/N', line: `(timeline ${from} → ${to})`, delta });
  }

  /** Enables the prompt once the emulator is ready. */
  enable() {
    this.#el.input.disabled = false;
    this.#el.input.focus();
  }

  /**
   * Echoes and runs one line: a slash command or an instruction.
   * @param {string} line
   */
  run(line) {
    this.#lines.push(line);
    this.#cursor = this.#lines.length;

    const echo = this.print('', 'in');
    const pc = document.createElement('span');
    pc.className = 'pc';
    pc.textContent = this.#promptText();
    echo.append(pc, ` ${line}`);

    const words = line.split(/\s+/);
    const head = words[0].toUpperCase();
    /** @type {StepEvent} */
    let event;
    try {
      event = head.startsWith('/') ? { ...this.#command(head, words.slice(1)), line } : this.#instruction(line, head);
    } catch (error) {
      if (!(error instanceof BrubeckError)) throw error;
      this.print(error.message, 'err');
      if (error.tip) this.print(error.tip, 'tip');
      event = { kind: error.kind === 'Crashed' ? 'crashed' : 'error', token: head, line };
    }
    this.updatePrompt();
    this.#onStep(event);
  }

  /**
   * @param {string} line
   * @param {string} mnemonic
   * @returns {StepEvent}
   */
  #instruction(line, mnemonic) {
    const delta = this.#emu.interpret(line);
    this.print(describeDelta(delta), 'ok');
    return { kind: 'instruction', token: mnemonic, line, delta };
  }

  /**
   * @param {string} head Upper-cased command word.
   * @param {string[]} args
   * @returns {Omit<StepEvent, 'line'>}
   */
  #command(head, args) {
    const name = COMMANDS[head];
    switch (name) {
      case '/HELP':
        this.print(HELP, 'table');
        return { kind: 'inspect', token: name };
      case '/REGS':
        this.print(this.#registers(args), 'table');
        return { kind: 'inspect', token: name };
      case '/MEMORY':
        this.print(this.#memory(args), 'table');
        return { kind: 'inspect', token: name };
      case '/P': {
        const delta = this.#emu.previous();
        this.print(`Navigated back: ${describeDelta(delta)}`, 'ok');
        return { kind: 'previous', token: name, delta };
      }
      case '/N': {
        const delta = this.#emu.next();
        this.print(`Navigated forward: ${describeDelta(delta)}`, 'ok');
        return { kind: 'next', token: name, delta };
      }
      case '/RESET':
        this.#emu.reset();
        this.print('CPU reset: registers, memory and history cleared.', 'ok');
        return { kind: 'reset', token: name };
      case '/CLEAR':
        this.clear();
        return { kind: 'clear', token: name };
      default:
        throw new BrubeckError('Generic', `Unknown command '${head.toLowerCase()}'.`, 'Type /help to see the commands.');
    }
  }

  /**
   * Formats `/regs` output.
   * @param {string[]} args Register names; empty for all.
   * @returns {string}
   */
  #registers(args) {
    const values = this.#emu.registers();
    if (!args.length) {
      const cells = values.map((v, i) => `${`x${i}`.padEnd(4)}${ABI_NAMES[i].padEnd(5)}${hex32(v)}`);
      const rows = [];
      for (let i = 0; i < 8; i++) rows.push([cells[i], cells[i + 8], cells[i + 16], cells[i + 24]].join('   '));
      return [...rows, `pc  ${hex32(this.#emu.pc)}`].join('\n');
    }
    return args.map((arg) => {
      if (arg.toLowerCase() === 'pc') return `pc: ${hex32(this.#emu.pc)}`;
      const index = parseRegister(arg);
      if (index === null) {
        throw new BrubeckError('InvalidRegister', `Invalid register: ${arg}`, 'Use x0-x31 or an ABI name like sp, a0 or t1.');
      }
      const v = values[index];
      return `x${index} (${ABI_NAMES[index]}): ${hex32(v)} (${String(v | 0).padStart(11)})`;
    }).join('\n');
  }

  /**
   * Formats `/memory` output.
   * @param {string[]} args `[]`, `[start]` or `[start, end]`.
   * @returns {string}
   */
  #memory(args) {
    const parsed = args.map(parseAddress);
    if (parsed.some((v) => v === null)) {
      throw new BrubeckError('Generic', `Invalid address: ${args[parsed.indexOf(null)]}`, 'Use decimal (256) or hex (0x100).');
    }
    const [first, second] = /** @type {number[]} */ (parsed);
    let start;
    let end;
    if (first === undefined) {
      start = Math.max(0, this.#emu.pc - 32) & ~0xf;
      end = start + 64;
    } else {
      start = first;
      end = second ?? first + 64;
    }
    if (end <= start) throw new BrubeckError('Generic', 'End address must be greater than start address.');
    if (end - start > 256) throw new BrubeckError('Generic', 'Memory range too large (max 256 bytes).');
    end = Math.min(end, this.#emu.memorySize);
    if (start >= end) {
      throw new BrubeckError('AccessViolation', `Address ${hex32(start)} is outside memory (${this.#emu.memorySize} bytes).`);
    }
    return hexDump(this.#emu.readMemory(start, end - start), start);
  }
}
