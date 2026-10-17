// @ts-check
/**
 * The six Brubeck Lab lessons. Content only: edit the text here freely, no
 * other code needs to change.
 *
 * In `body` paragraphs, text wrapped in backticks is rendered as inline code.
 * Each challenge check is a predicate over a {@link LabState} snapshot that the
 * lab evaluates after every instruction or history move.
 *
 * @module lessons
 */

/**
 * A read-only view of the emulator handed to challenge checks.
 * @typedef {Object} LabState
 * @property {(index: number) => number} reg Unsigned value of register x`index`.
 * @property {(address: number) => number} word Little-endian 32-bit word at `address` (0 if out of range).
 * @property {number} pc Program counter.
 * @property {Set<string>} used Upper-cased mnemonics and slash commands run during this step, e.g. `"ADD"`, `"/P"`.
 * @property {(index: number) => string | undefined} writer Mnemonic of the instruction, still in effect, that last changed x`index`.
 * @property {(token: string, index: number) => boolean} wrote True if an instruction `token` still in effect changed x`index`.
 */

/**
 * @typedef {Object} Example
 * @property {string} code Line pasted into the REPL when clicked.
 * @property {string} note Short explanation shown beside it.
 */

/**
 * @typedef {Object} Check
 * @property {string} label Shown next to the checkbox, e.g. `x1 == 100`.
 * @property {(state: LabState) => boolean} test
 */

/**
 * @typedef {Object} Lesson
 * @property {string} tab Short label for the step tab.
 * @property {string} title
 * @property {string[]} body Paragraphs; `backticks` become inline code.
 * @property {Example[]} examples
 * @property {{prompt: string, checks: Check[], hint: string}} challenge
 */

/** @type {readonly Lesson[]} */
export const LESSONS = Object.freeze([
  {
    tab: 'Registers',
    title: 'Put a number in a register',
    body: [
      'A CPU does its work in registers: 32 small slots, `x0` to `x31`, each holding one 32-bit number. Most also have a nickname, like `ra` or `sp`, which you can see next to each one below.',
      '`x0` is special. It is always zero, and you can type it as `zero`. `ADDI x1, zero, 100` means "x1 = zero + 100". Brubeck prints exactly what changed, and the address in the prompt (the PC) moves forward by 4.',
    ],
    examples: [
      { code: 'ADDI x1, zero, 100', note: 'x1 = 0 + 100' },
      { code: '/regs x1', note: 'look at x1' },
      { code: '/regs', note: 'look at all of them' },
    ],
    challenge: {
      prompt: 'Make register x1 hold 100.',
      checks: [{ label: 'x1 == 100', test: (s) => s.reg(1) === 100 }],
      hint: 'Add 100 to zero and put the result in x1: `ADDI x1, zero, 100`.',
    },
  },
  {
    tab: 'Adding',
    title: 'Add two registers',
    body: [
      '`ADDI` adds a register and a small constant written in the instruction itself, called an immediate. It has to fit in 12 bits, so it can be anything from -2048 to 2047.',
      '`ADD` adds two registers instead: `ADD x3, x1, x2` means "x3 = x1 + x2". `SUB` subtracts the same way. Nothing ever overflows with an error; results simply wrap around at 32 bits.',
    ],
    examples: [
      { code: 'ADDI x1, zero, 20', note: 'x1 = 20' },
      { code: 'ADDI x2, zero, 22', note: 'x2 = 22' },
      { code: 'ADD x3, x1, x2', note: 'x3 = x1 + x2' },
      { code: 'SUB x4, x3, x1', note: 'x4 = x3 - x1' },
    ],
    challenge: {
      prompt: 'Make x3 hold 42 by adding two registers.',
      checks: [
        { label: 'x3 == 42', test: (s) => s.reg(3) === 42 },
        { label: 'x3 written by ADD', test: (s) => s.writer(3) === 'ADD' },
      ],
      hint: 'Put two numbers that add up to 42 in x1 and x2, then run `ADD x3, x1, x2`.',
    },
  },
  {
    tab: 'History',
    title: 'Step back in time',
    body: [
      'Brubeck records every instruction. `/p` (previous) steps back one instruction and puts back exactly what it changed: registers, memory and the PC. `/n` (next) replays it. The counter at the top of the REPL shows where you are.',
      'If you step back and then run a new instruction, the steps ahead of you are thrown away, the way a browser forgets its forward pages once you follow a new link.',
    ],
    examples: [
      { code: 'ADDI x5, zero, 1', note: 'x5 = 1' },
      { code: 'ADDI x5, x5, 1', note: 'x5 = x5 + 1' },
      { code: '/p', note: 'step back' },
      { code: '/n', note: 'step forward' },
    ],
    challenge: {
      prompt: 'Change x5, step back with /p, then forward again with /n.',
      checks: [
        { label: 'used /p', test: (s) => s.used.has('/P') },
        { label: 'used /n', test: (s) => s.used.has('/N') },
        { label: 'x5 != 0', test: (s) => s.reg(5) !== 0 },
      ],
      hint: 'Run `ADDI x5, zero, 1`, then `/p` (x5 goes back to 0), then `/n` (x5 is 1 again).',
    },
  },
  {
    tab: 'Shifts',
    title: 'Shift bits left and right',
    body: [
      'Shifting moves every bit of a number sideways. `SLLI x2, x1, 3` shifts x1 left by 3 places, which multiplies it by 2³ = 8. The shift amount can be 0 to 31.',
      '`SRLI` shifts right and fills the top with zeros, which divides an unsigned number. `SRAI` copies the sign bit into the top instead, so negative numbers stay negative: -16 shifted right by 2 is -4.',
    ],
    examples: [
      { code: 'ADDI x1, zero, 5', note: 'x1 = 5' },
      { code: 'SLLI x2, x1, 3', note: 'x2 = 5 × 8' },
      { code: 'ADDI x3, zero, -16', note: 'x3 = -16' },
      { code: 'SRAI x4, x3, 2', note: 'x4 = -16 ÷ 4' },
      { code: 'SRLI x5, x3, 28', note: 'zeros shift in' },
    ],
    challenge: {
      prompt: 'Make x2 hold 80 using a left shift.',
      checks: [
        { label: 'x2 == 80', test: (s) => s.reg(2) === 80 },
        { label: 'x2 written by a left shift', test: (s) => ['SLLI', 'SLL'].includes(s.writer(2) ?? '') },
      ],
      hint: '80 = 5 × 16, and 16 = 2⁴. Try `ADDI x1, zero, 5`, then `SLLI x2, x1, 4`.',
    },
  },
  {
    tab: 'Big numbers',
    title: 'Build a 32-bit constant',
    body: [
      'An immediate only has 12 bits, so `ADDI` can\'t load a number like 0x12345678 by itself. `LUI` (load upper immediate) fills the top 20 bits of a register and clears the bottom 12: `LUI x1, 0x12345` gives 0x12345000. Then `ADDI` adds the bottom 12 bits.',
      'The pseudo-instruction `LI` does both steps for you. Brubeck counts it as a single step, so one `/p` steps back over all of it. One catch when doing it by hand: `ADDI` treats its immediate as signed, so if the low part is 0x800 or more, add 1 to the `LUI` value to make up for it.',
    ],
    examples: [
      { code: 'LUI x1, 0x12345', note: 'top 20 bits' },
      { code: 'ADDI x1, x1, 0x678', note: 'bottom 12 bits' },
      { code: 'LI x2, 0x12345678', note: 'both at once' },
    ],
    challenge: {
      prompt: 'Put 0x12345678 in x1 with LUI and ADDI.',
      checks: [
        { label: 'x1 == 0x12345678', test: (s) => s.reg(1) === 0x12345678 },
        { label: 'x1 built with LUI', test: (s) => s.wrote('LUI', 1) },
      ],
      hint: 'Run `LUI x1, 0x12345`, then `ADDI x1, x1, 0x678`.',
    },
  },
  {
    tab: 'Memory',
    title: 'Store and load',
    body: [
      'There are only 32 registers, but memory is large: 1 MiB here, one address per byte. `SW x2, 0(x1)` stores the 32-bit word in x2 at address x1 + 0. `LW x3, 0(x1)` loads it back. The `offset(base)` form lets you reach nearby addresses without changing the base register.',
      'RISC-V is little-endian: the lowest byte of a word goes at the lowest address. Store 0x11223344 and look with `/memory`; you\'ll see 44 33 22 11.',
    ],
    examples: [
      { code: 'LI x1, 0x100', note: 'base address' },
      { code: 'LI x2, 0x11223344', note: 'value to store' },
      { code: 'SW x2, 0(x1)', note: 'memory[x1] = x2' },
      { code: '/memory 0x100', note: 'see the bytes' },
      { code: 'LW x3, 0(x1)', note: 'x3 = memory[x1]' },
    ],
    challenge: {
      prompt: 'Store 0x11223344 at address 0x100, then load it into x3.',
      checks: [
        { label: 'memory[0x100] == 0x11223344', test: (s) => s.word(0x100) === 0x11223344 },
        { label: 'x3 == 0x11223344', test: (s) => s.reg(3) === 0x11223344 },
        { label: 'x3 loaded with LW', test: (s) => s.writer(3) === 'LW' },
      ],
      hint: 'Put 0x100 in x1 and the value in x2 (`LI` works for both), then `SW x2, 0(x1)` and `LW x3, 0(x1)`.',
    },
  },
]);
