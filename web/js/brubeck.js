// @ts-check
/**
 * Friendly JavaScript API over the Brubeck WebAssembly bindings.
 *
 * The Rust side (`crates/brubeck-wasm`) exposes raw, flat data so nothing has
 * to be serialized across the wasm boundary. This module turns that into plain
 * objects, converts thrown values into {@link BrubeckError}, and frees every
 * wasm-allocated object as soon as it has been read.
 *
 * @example
 * import { Emulator } from './js/brubeck.js';
 *
 * const emu = await Emulator.create();
 * const delta = emu.interpret('ADDI x1, zero, 42');
 * console.log(delta.registers); // [{ index: 1, abi: 'ra', before: 0, after: 42 }]
 *
 * @module brubeck
 */

import init, { Emulator as RawEmulator } from '../pkg/brubeck_wasm.js';

/**
 * ABI names of x0..x31, indexed by register number.
 * @type {readonly string[]}
 */
export const ABI_NAMES = Object.freeze([
  'zero', 'ra', 'sp', 'gp', 'tp', 't0', 't1', 't2',
  's0', 's1', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5',
  'a6', 'a7', 's2', 's3', 's4', 's5', 's6', 's7',
  's8', 's9', 's10', 's11', 't3', 't4', 't5', 't6',
]);

/** Default memory size: 1 MiB, the same as the terminal REPL. */
export const DEFAULT_MEMORY_SIZE = 1 << 20;

/** Default number of steps kept in history. */
export const DEFAULT_HISTORY_LIMIT = 1000;

/**
 * A register whose value changed.
 * @typedef {Object} RegisterChange
 * @property {number} index  Register number, 0-31.
 * @property {string} abi    ABI name, e.g. `"ra"`.
 * @property {number} before Value before the step (unsigned 32-bit).
 * @property {number} after  Value after the step (unsigned 32-bit).
 */

/**
 * A memory byte whose value changed.
 * @typedef {Object} MemoryChange
 * @property {number} address Byte address.
 * @property {number} before  Byte value before the step.
 * @property {number} after   Byte value after the step.
 */

/**
 * A control and status register whose value changed.
 * @typedef {Object} CsrChange
 * @property {number} address 12-bit CSR address.
 * @property {number} before  Value before the step.
 * @property {number} after   Value after the step.
 */

/**
 * Everything that changed during one step: an instruction, or a move through
 * history.
 * @typedef {Object} StateDelta
 * @property {{before: number, after: number}} pc Program counter movement.
 * @property {RegisterChange[]} registers Changed registers.
 * @property {MemoryChange[]} memory Changed memory bytes, one entry per byte.
 * @property {CsrChange[]} csrs Changed CSRs.
 */

/**
 * Options for {@link Emulator.create}.
 * @typedef {Object} EmulatorOptions
 * @property {number} [memorySize]   Memory size in bytes. Defaults to {@link DEFAULT_MEMORY_SIZE}.
 * @property {number} [historyLimit] Steps of history to keep. Defaults to {@link DEFAULT_HISTORY_LIMIT}.
 */

/**
 * Error kinds reported by the emulator. The first group comes from parsing,
 * the second from executing, the third from history navigation; `"Crashed"`
 * means the WebAssembly module trapped and the emulator must be recreated.
 * @typedef {'UnknownInstruction' | 'UnrecognizedToken' | 'InvalidRegister'
 *   | 'WrongArgumentCount' | 'ImmediateOutOfRange' | 'Generic'
 *   | 'MisalignedJump' | 'AccessViolation' | 'EnvironmentCall' | 'Breakpoint'
 *   | 'IllegalInstruction'
 *   | 'AtBeginning' | 'AtEnd'
 *   | 'Crashed'} ErrorKind
 */

/**
 * An error raised by the emulator, with the library's educational tip and
 * suggested correction kept as separate fields.
 */
export class BrubeckError extends Error {
  /**
   * @param {ErrorKind} kind Machine-readable error kind.
   * @param {string} message The main message.
   * @param {string | null} [tip] Educational tip, if any.
   * @param {string | null} [suggestion] Suggested correction, e.g. `"ADD or ADDI"`.
   */
  constructor(kind, message, tip = null, suggestion = null) {
    super(message);
    this.name = 'BrubeckError';
    /** @type {ErrorKind} */
    this.kind = kind;
    /** @type {string | null} */
    this.tip = tip;
    /** @type {string | null} */
    this.suggestion = suggestion;
  }
}

/** @type {Promise<unknown> | null} */
let loading = null;

/**
 * Loads and instantiates the WebAssembly module. Safe to call repeatedly; the
 * module is fetched once. {@link Emulator.create} calls this for you.
 * @returns {Promise<void>}
 */
export async function load() {
  loading ??= init();
  await loading;
}

/**
 * Splits a flat `[a, b, c, a, b, c, ...]` array into mapped triples.
 * @template T
 * @param {ArrayLike<number>} flat
 * @param {(a: number, b: number, c: number) => T} map
 * @returns {T[]}
 */
function triples(flat, map) {
  /** @type {T[]} */
  const out = [];
  for (let i = 0; i + 2 < flat.length; i += 3) {
    out.push(map(flat[i], flat[i + 1], flat[i + 2]));
  }
  return out;
}

/**
 * Converts a raw wasm `Delta` into a {@link StateDelta} and frees it.
 * @param {import('../pkg/brubeck_wasm.js').Delta} raw
 * @returns {StateDelta}
 */
function toDelta(raw) {
  try {
    return {
      pc: { before: raw.pcBefore, after: raw.pcAfter },
      registers: triples(raw.registers(), (index, before, after) => ({
        index, abi: ABI_NAMES[index] ?? `x${index}`, before, after,
      })),
      memory: triples(raw.memory(), (address, before, after) => ({ address, before, after })),
      csrs: triples(raw.csrs(), (address, before, after) => ({ address, before, after })),
    };
  } finally {
    raw.free();
  }
}

/**
 * True if `value` looks like a `RawError` thrown by the bindings.
 * @param {unknown} value
 * @returns {value is import('../pkg/brubeck_wasm.js').RawError}
 */
function isRawError(value) {
  return typeof value === 'object' && value !== null
    && typeof (/** @type {{kind?: unknown}} */ (value)).kind === 'string'
    && typeof (/** @type {{free?: unknown}} */ (value)).free === 'function';
}

/**
 * Drives an RV32I hart compiled to WebAssembly: run assembly, inspect state,
 * and move back and forth through history.
 */
export class Emulator {
  /** @type {RawEmulator} */
  #raw;

  /** Set once the wasm module has trapped; every later call then fails fast. */
  #crashed = false;

  /** Set by {@link Emulator#dispose}; the wasm memory has been released. */
  #disposed = false;

  /**
   * Use {@link Emulator.create} instead; the constructor needs the wasm
   * module to be loaded already.
   * @param {EmulatorOptions} [options]
   */
  constructor({ memorySize = DEFAULT_MEMORY_SIZE, historyLimit = DEFAULT_HISTORY_LIMIT } = {}) {
    this.#raw = new RawEmulator(memorySize, historyLimit);
  }

  /**
   * Loads the WebAssembly module (once) and creates an emulator.
   * @param {EmulatorOptions} [options]
   * @returns {Promise<Emulator>}
   */
  static async create(options) {
    await load();
    return new Emulator(options);
  }

  /**
   * Runs `operation` against the raw emulator, translating errors.
   * @template T
   * @param {(raw: RawEmulator) => T} operation
   * @returns {T}
   */
  #call(operation) {
    if (this.#disposed) {
      throw new BrubeckError('Crashed', 'This emulator has been disposed. Create a new one to continue.');
    }
    if (this.#crashed) {
      throw new BrubeckError('Crashed', 'The emulator crashed. Create a new one to continue.');
    }
    try {
      return operation(this.#raw);
    } catch (error) {
      if (isRawError(error)) {
        const converted = new BrubeckError(
          /** @type {ErrorKind} */ (error.kind),
          error.message,
          error.tip ?? null,
          error.suggestion ?? null,
        );
        error.free();
        throw converted;
      }
      if (error instanceof WebAssembly.RuntimeError) {
        // A Rust panic surfaces as a trap and leaves the module unusable.
        this.#crashed = true;
        throw new BrubeckError('Crashed', `The emulator crashed: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Parses and executes one line of assembly, e.g. `"ADDI x1, zero, 42"`.
   * Pseudo-instructions such as `LI` that expand to several instructions run
   * as a single step.
   * @param {string} line
   * @returns {StateDelta} What changed.
   * @throws {BrubeckError} On a parse or execution error. State is unchanged.
   */
  interpret(line) {
    return this.#call((raw) => toDelta(raw.interpret(line)));
  }

  /**
   * Steps back one entry in history.
   * @returns {StateDelta} The changes applied to restore the earlier state.
   * @throws {BrubeckError} With kind `"AtBeginning"` when there is nothing to undo.
   */
  previous() {
    return this.#call((raw) => toDelta(raw.previous()));
  }

  /**
   * Steps forward one entry in history.
   * @returns {StateDelta} The changes re-applied.
   * @throws {BrubeckError} With kind `"AtEnd"` when already at the latest state.
   */
  next() {
    return this.#call((raw) => toDelta(raw.next()));
  }

  /** Clears registers, memory, CSRs and history. */
  reset() {
    this.#call((raw) => raw.reset());
  }

  /**
   * Current values of x0..x31 as unsigned 32-bit numbers.
   * @returns {number[]}
   */
  registers() {
    return this.#call((raw) => Array.from(raw.registers()));
  }

  /**
   * Current program counter.
   * @returns {number}
   */
  get pc() {
    return this.#call((raw) => raw.pc);
  }

  /**
   * Total memory size in bytes.
   * @returns {number}
   */
  get memorySize() {
    return this.#call((raw) => raw.memorySize);
  }

  /**
   * Copies `length` bytes of memory starting at `address`.
   * @param {number} address
   * @param {number} length
   * @returns {Uint8Array}
   * @throws {BrubeckError} With kind `"AccessViolation"` if the range leaves memory.
   */
  readMemory(address, length) {
    return this.#call((raw) => raw.readMemory(address, length));
  }

  /**
   * Reads a control and status register.
   * @param {number} address 12-bit CSR address, e.g. `0x300` for `mstatus`.
   * @returns {number}
   * @throws {BrubeckError} With kind `"IllegalInstruction"` if the CSR doesn't exist.
   */
  readCsr(address) {
    return this.#call((raw) => raw.readCsr(address));
  }

  /** Releases the WebAssembly memory held by this emulator. Safe to call twice. */
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#raw.free();
  }
}
