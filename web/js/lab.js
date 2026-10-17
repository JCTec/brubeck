// @ts-check
/**
 * Brubeck Lab: wires the lessons, the REPL, the register panel and progress
 * tracking together. Entry point loaded by `index.html`.
 * @module lab
 */

import { Emulator, BrubeckError } from './brubeck.js';
import { LESSONS } from './lessons.js';
import { Repl, destinationRegister, parseAddress } from './repl.js';
import { renderRegisters, hex32 } from './registers.js';
import { renderMemory, windowStart, WINDOW_SIZE } from './memory.js';

/** @typedef {import('./lessons.js').LabState} LabState */
/** @typedef {import('./repl.js').StepEvent} StepEvent */
/** @typedef {import('./brubeck.js').StateDelta} StateDelta */

const STORAGE_KEY = 'brubeck-lab:v1';

/** Most lines a shared link will replay, so a huge link can't hang the page. */
const MAX_SHARED_LINES = 1000;
/** Longest line a shared link may contain. */
const MAX_SHARED_LINE_LENGTH = 200;

/**
 * Persisted progress. Stored per browser; the lab works without it.
 * @typedef {Object} Progress
 * @property {number[]} completed Indices of completed lessons.
 * @property {number} current Index of the lesson last open.
 */

/** @returns {Progress} */
function loadProgress() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (raw && Array.isArray(raw.completed) && Number.isInteger(raw.current)) {
      return {
        completed: [...new Set(raw.completed.filter((/** @type {unknown} */ i) => Number.isInteger(i) && Number(i) >= 0 && Number(i) < LESSONS.length))],
        current: Math.min(Math.max(raw.current, 0), LESSONS.length - 1),
      };
    }
  } catch {
    // Storage unavailable (private mode, blocked cookies): start fresh.
  }
  return { completed: [], current: 0 };
}

/** @param {Progress} progress */
function saveProgress(progress) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
  } catch {
    // Not fatal: progress just won't survive a reload.
  }
}

/**
 * Looks up a required element by id.
 * @template {HTMLElement} T
 * @param {string} id
 * @param {new () => T} type
 * @returns {T}
 */
function $(id, type) {
  const found = document.getElementById(id);
  if (!(found instanceof type)) throw new Error(`Brubeck Lab: missing #${id}`);
  return found;
}

/**
 * Appends `text` to `parent`, turning `backtick` spans into `<code>`.
 * @param {HTMLElement} parent
 * @param {string} text
 */
function appendRich(parent, text) {
  text.split('`').forEach((part, i) => {
    if (!part) return;
    if (i % 2) {
      const code = document.createElement('code');
      code.textContent = part;
      parent.append(code);
    } else {
      parent.append(part);
    }
  });
}

/**
 * Reads a session shared through the URL hash, e.g.
 * `#step=6&run=LI+x1,+0x100%0ASW+x2,+0(x1)`.
 * @returns {{step: number | null, lines: string[]} | null} Null when the hash holds no session.
 */
function readSharedSession() {
  const params = new URLSearchParams(location.hash.slice(1));
  const run = params.get('run');
  const stepParam = params.get('step');
  if (run === null && stepParam === null) return null;
  const step = Number(stepParam) - 1;
  return {
    step: Number.isInteger(step) && step >= 0 && step < LESSONS.length ? step : null,
    lines: (run ?? '')
      .split('\n')
      .map((line) => line.trim().slice(0, MAX_SHARED_LINE_LENGTH))
      .filter(Boolean)
      .slice(0, MAX_SHARED_LINES),
  };
}

/** Two-digit step number, e.g. `03`. */
const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');

const el = {
  progressLabel: $('progress-label', HTMLElement),
  progressBoxes: $('progress-boxes', HTMLOListElement),
  tabs: $('tabs', HTMLElement),
  lesson: $('lesson', HTMLElement),
  stepLabel: $('step-label', HTMLElement),
  title: $('lesson-title', HTMLHeadingElement),
  body: $('lesson-body', HTMLElement),
  examples: $('examples', HTMLUListElement),
  challenge: $('challenge', HTMLElement),
  challengePrompt: $('challenge-prompt', HTMLElement),
  checks: $('checks', HTMLUListElement),
  hintToggle: $('hint-toggle', HTMLButtonElement),
  hint: $('hint', HTMLElement),
  prevStep: $('prev-step', HTMLButtonElement),
  nextStep: $('next-step', HTMLButtonElement),
  history: $('history', HTMLElement),
  scrubber: $('scrubber', HTMLInputElement),
  btnPrev: $('btn-prev', HTMLButtonElement),
  btnNext: $('btn-next', HTMLButtonElement),
  btnReset: $('btn-reset', HTMLButtonElement),
  btnClear: $('btn-clear', HTMLButtonElement),
  btnShare: $('btn-share', HTMLButtonElement),
  registers: $('registers', HTMLElement),
  tabRegisters: $('tab-registers', HTMLButtonElement),
  tabMemory: $('tab-memory', HTMLButtonElement),
  viewRegisters: $('view-registers', HTMLElement),
  viewMemory: $('view-memory', HTMLElement),
  memory: $('memory', HTMLElement),
  memAddr: $('mem-addr', HTMLInputElement),
  memAddrHelp: $('mem-addr-help', HTMLElement),
  pcValue: $('pc-value', HTMLElement),
  log: $('log', HTMLElement),
  form: $('prompt', HTMLFormElement),
  input: $('line', HTMLInputElement),
  promptPc: $('prompt-pc', HTMLElement),
};

/**
 * One executed instruction, kept in step with the emulator's history so
 * challenges can ask which instruction actually produced a value.
 * @typedef {Object} TrailEntry
 * @property {string} token Upper-cased mnemonic, e.g. `"ADD"`.
 * @property {string} line The line as typed, for sharing.
 * @property {Set<number>} registers Registers this instruction wrote (its destination plus anything it changed).
 */

/** Main controller. */
class Lab {
  /** @type {Emulator} */ #emu;
  /** @type {Repl} */ #repl;
  /** @type {Progress} */ #progress = loadProgress();
  /** Commands and mnemonics run since the current lesson was opened. */
  /** @type {Set<string>} */ #used = new Set();
  /** @type {number[]} */ #changed = [];
  /**
   * Executed instructions; entry `i` corresponds to history entry `i`, so the
   * first `history.position` entries are the ones currently in effect.
   * @type {TrailEntry[]}
   */
  #trail = [];
  /** False once the history limit has dropped trail entries, so it can't be replayed. */
  #trailComplete = true;
  /** True while a shared link is replaying; replayed lines don't complete challenges. */
  #replaying = false;
  /** @type {HTMLButtonElement[]} */ #tabButtons = [];
  /** History position when the current scrubber gesture began, or null. */
  /** @type {number | null} */ #scrubFrom = null;
  /** Which view the dark panel shows. */
  /** @type {'registers' | 'memory'} */ #view = 'registers';
  /** Memory addresses changed by the last step. */
  /** @type {Set<number>} */ #memoryChanged = new Set();
  /** Lowest address changed by the most recent step that changed memory. */
  /** @type {number | null} */ #lastWrite = null;
  /** Address typed into the memory view, or null to follow the last write. */
  /** @type {number | null} */ #pinned = null;

  /** @param {Emulator} emulator */
  constructor(emulator) {
    this.#emu = emulator;
    this.#repl = new Repl(emulator, el, (event) => this.#onStep(event));

    el.btnPrev.addEventListener('click', () => this.#repl.run('/p'));
    el.btnNext.addEventListener('click', () => this.#repl.run('/n'));
    el.btnReset.addEventListener('click', () => this.#repl.run('/reset'));
    el.btnClear.addEventListener('click', () => this.#repl.clear());
    el.btnShare.addEventListener('click', () => this.#share());
    // `input` fires while dragging and per arrow key; `change` once the move ends.
    el.scrubber.addEventListener('input', () => this.#scrub(false));
    el.scrubber.addEventListener('change', () => this.#scrub(true));
    el.tabRegisters.addEventListener('click', () => this.#showView('registers'));
    el.tabMemory.addEventListener('click', () => this.#showView('memory'));
    for (const tab of [el.tabRegisters, el.tabMemory]) {
      tab.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const view = event.key === 'Home' ? 'registers'
          : event.key === 'End' ? 'memory'
          : this.#view === 'registers' ? 'memory' : 'registers';
        this.#showView(view);
        (view === 'registers' ? el.tabRegisters : el.tabMemory).focus();
      });
    }
    el.memAddr.addEventListener('change', () => this.#setAddress());
    el.memAddr.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.#setAddress();
    });
    el.prevStep.addEventListener('click', () => this.open(this.#progress.current - 1));
    el.nextStep.addEventListener('click', () => this.open(this.#progress.current + 1));
    el.hintToggle.addEventListener('click', () => this.#toggleHint());

    this.#buildTabs();
    this.#repl.print('Brubeck: A RISC-V REPL');
    this.#repl.print('Type an instruction and press Enter. /help lists commands.');
    const shared = readSharedSession();
    this.open(shared?.step ?? this.#progress.current);
    this.#refreshMachine();
    if (shared) this.#replay(shared.lines);
    this.#repl.enable();
  }

  /**
   * Runs the lines from a shared link, then removes them from the address bar
   * so a reload doesn't replay them on top of later work.
   * @param {string[]} lines
   */
  #replay(lines) {
    history.replaceState(null, '', location.pathname + location.search);
    if (!lines.length) return;
    this.#repl.print(`Replaying a shared session (${lines.length} line${lines.length === 1 ? '' : 's'}).`, 'tip');
    this.#replaying = true;
    try {
      for (const line of lines) this.#repl.run(line);
    } finally {
      this.#replaying = false;
    }
  }

  /** Copies a link that replays the instructions currently in effect. */
  async #share() {
    if (!this.#trailComplete) {
      this.#repl.print('This session is longer than the history limit, so it can\'t be replayed from a link. Use /reset and try again.', 'err');
      return;
    }
    const lines = this.#trail.slice(0, this.#emu.history.position).map((entry) => entry.line);
    const params = new URLSearchParams({ step: String(this.#current + 1) });
    if (lines.length) params.set('run', lines.join('\n'));
    const url = `${location.origin}${location.pathname}${location.search}#${params}`;
    const what = lines.length ? `${lines.length} instruction${lines.length === 1 ? '' : 's'}` : 'this step';
    // Print first: the clipboard can be blocked, or wait on a permission prompt.
    const message = this.#repl.print(`Link to ${what}: ${url}`, 'ok');
    try {
      await navigator.clipboard.writeText(url);
      message.textContent = `Copied a link to ${what}: ${url}`;
    } catch {
      // The printed link is still there to copy by hand.
    }
  }

  /** @returns {number} */
  get #current() {
    return this.#progress.current;
  }

  /**
   * Opens lesson `index`.
   * @param {number} index
   */
  open(index) {
    if (index < 0 || index >= LESSONS.length) return;
    const lesson = LESSONS[index];
    this.#progress.current = index;
    this.#used = new Set();
    saveProgress(this.#progress);

    el.stepLabel.textContent = `Step ${pad(index + 1)} of ${pad(LESSONS.length)}`;
    el.title.textContent = lesson.title;
    el.body.replaceChildren(...lesson.body.map((text) => {
      const p = document.createElement('p');
      appendRich(p, text);
      return p;
    }));

    el.examples.replaceChildren(...lesson.examples.map(({ code, note }) => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'example';
      button.title = 'Paste into the REPL';
      const codeEl = document.createElement('code');
      codeEl.textContent = code;
      const noteEl = document.createElement('span');
      noteEl.className = 'note';
      noteEl.textContent = note;
      button.append(codeEl, noteEl);
      button.addEventListener('click', () => this.#repl.paste(code));
      li.append(button);
      return li;
    }));

    el.challengePrompt.textContent = lesson.challenge.prompt;
    el.checks.replaceChildren(...lesson.challenge.checks.map(({ label }) => {
      const li = document.createElement('li');
      li.textContent = label;
      return li;
    }));
    el.hint.replaceChildren();
    appendRich(el.hint, lesson.challenge.hint);
    el.hint.hidden = true;
    el.hintToggle.textContent = 'Show hint';
    el.hintToggle.setAttribute('aria-expanded', 'false');
    el.challenge.querySelector('.challenge-done')?.remove();

    el.lesson.scrollTop = 0;
    this.#repl.banner(`Step ${pad(index + 1)} · ${lesson.title}`);
    this.#evaluate(false);
  }

  #toggleHint() {
    el.hint.hidden = !el.hint.hidden;
    el.hintToggle.textContent = el.hint.hidden ? 'Show hint' : 'Hide hint';
    el.hintToggle.setAttribute('aria-expanded', String(!el.hint.hidden));
  }

  /**
   * Reacts to every line run in the REPL.
   * @param {StepEvent} event
   */
  #onStep(event) {
    if (event.kind === 'crashed') {
      this.#restart();
      return;
    }
    if (event.kind === 'error' || event.kind === 'clear') return;
    this.#used.add(event.token);
    if (event.delta) this.#noteDelta(event.delta);

    if (event.kind === 'instruction' && event.delta) {
      // The new instruction is the latest history entry; anything that was
      // ahead of the old position has been discarded by the emulator.
      const { position, length } = this.#emu.history;
      this.#trail = this.#trail.slice(0, Math.max(0, position - 1));
      // Credit the destination even when its value didn't change, so
      // `ADD x3, x1, x2` counts as writing x3 even if x3 already held the sum.
      const registers = new Set(this.#changed);
      const rd = destinationRegister(event.line);
      if (rd !== null) registers.add(rd);
      this.#trail.push({ token: event.token, line: event.line, registers });
      // The history limit drops the oldest entries; drop them here too.
      while (this.#trail.length > length) {
        this.#trail.shift();
        this.#trailComplete = false;
      }
    } else if (event.kind === 'reset') {
      this.#trail = [];
      this.#trailComplete = true;
      this.#forgetChanges();
    }

    this.#refreshMachine();
    // Only actions that change machine state can complete a challenge;
    // inspecting (/regs, /help, /memory) never does.
    const changesState = event.kind === 'instruction' || event.kind === 'previous' || event.kind === 'next';
    this.#evaluate(changesState && !this.#replaying);
  }

  /**
   * Follows the timeline scrubber. Every update moves from where the gesture
   * started, so the highlights always show the net change of the whole drag.
   * @param {boolean} done True when the gesture has ended.
   */
  #scrub(done) {
    const to = el.scrubber.valueAsNumber;
    const from = (this.#scrubFrom ??= this.#emu.history.position);
    let delta;
    try {
      this.#emu.goTo(from);
      delta = this.#emu.goTo(to);
    } catch (error) {
      this.#scrubFrom = null;
      if (error instanceof BrubeckError && error.kind === 'Crashed') this.#restart();
      else this.#refreshMachine();
      return;
    }
    if (!done) {
      this.#noteDelta(delta);
      this.#refreshMachine();
      return;
    }
    this.#scrubFrom = null;
    if (to === from) this.#refreshMachine();
    else this.#repl.reportMove(delta, from, to);
  }

  /**
   * Remembers what a step changed, for the highlights and the memory view.
   * @param {StateDelta} delta
   */
  #noteDelta(delta) {
    this.#changed = delta.registers.map((r) => r.index);
    const addresses = delta.memory.map((m) => m.address);
    this.#memoryChanged = new Set(addresses);
    if (addresses.length) this.#lastWrite = Math.min(...addresses);
  }

  /** Clears highlights and the last-write marker (after a reset). */
  #forgetChanges() {
    this.#changed = [];
    this.#memoryChanged = new Set();
    this.#lastWrite = null;
  }

  /**
   * Switches the dark panel between registers and memory.
   * @param {'registers' | 'memory'} view
   */
  #showView(view) {
    this.#view = view;
    const memory = view === 'memory';
    el.tabRegisters.setAttribute('aria-selected', String(!memory));
    el.tabMemory.setAttribute('aria-selected', String(memory));
    el.tabRegisters.tabIndex = memory ? -1 : 0;
    el.tabMemory.tabIndex = memory ? 0 : -1;
    el.viewRegisters.hidden = memory;
    el.viewMemory.hidden = !memory;
    this.#refreshMachine();
  }

  /** Applies the memory view's address field: an address pins the view; empty follows writes. */
  #setAddress() {
    const text = el.memAddr.value.trim();
    const address = text ? parseAddress(text) : null;
    const valid = !text || (address !== null && address < this.#emu.memorySize);
    el.memAddr.setAttribute('aria-invalid', String(!valid));
    if (!valid) {
      el.memAddrHelp.textContent = `Not an address in memory (0x00000000 to ${hex32(this.#emu.memorySize - 1)}).`;
      return;
    }
    this.#pinned = address;
    this.#refreshMachine();
  }

  /** Redraws the memory grid around the pinned address, the last write, or the PC. */
  #renderMemory() {
    const size = this.#emu.memorySize;
    const focus = this.#pinned ?? this.#lastWrite ?? this.#emu.pc;
    const start = windowStart(focus, size);
    const bytes = this.#emu.readMemory(start, Math.min(WINDOW_SIZE, size - start));
    renderMemory(el.memory, bytes, start, this.#memoryChanged);
    if (el.memAddr.getAttribute('aria-invalid') === 'true') return;
    el.memAddr.placeholder = hex32(focus);
    el.memAddrHelp.textContent = this.#pinned !== null
      ? 'Hex or decimal. Clear it to follow the last write.'
      : this.#lastWrite !== null
        ? 'Following the last write. Type an address to look elsewhere.'
        : 'No writes yet, so showing the PC. Type an address to look elsewhere.';
  }

  /** Replaces a crashed emulator with a fresh one so the lab keeps working. */
  #restart() {
    try {
      this.#emu.dispose();
    } catch {
      // Already unusable.
    }
    this.#emu = new Emulator();
    this.#repl.setEmulator(this.#emu);
    this.#trail = [];
    this.#trailComplete = true;
    this.#forgetChanges();
    this.#repl.print('The emulator was restarted. Registers, memory and history were reset.', 'tip');
    this.#refreshMachine();
    this.#evaluate(false);
  }

  /** Redraws registers, PC and history controls from the emulator. */
  #refreshMachine() {
    renderRegisters(el.registers, el.pcValue, this.#emu.registers(), this.#emu.pc, this.#changed);
    if (this.#view === 'memory') this.#renderMemory();
    const { position, length } = this.#emu.history;
    el.history.textContent = `History ${position} / ${length}`;
    el.scrubber.max = String(length);
    el.scrubber.value = String(position);
    el.scrubber.setAttribute('aria-valuetext', `${position} of ${length}`);
    this.#setDisabled(el.scrubber, length === 0);
    this.#setDisabled(el.btnPrev, position === 0);
    this.#setDisabled(el.btnNext, position >= length);
    this.#repl.updatePrompt();
  }

  /**
   * Disables a control without stranding keyboard focus on it.
   * @param {HTMLButtonElement | HTMLInputElement} button
   * @param {boolean} disabled
   */
  #setDisabled(button, disabled) {
    if (disabled && document.activeElement === button) el.input.focus();
    button.disabled = disabled;
  }

  /** @returns {LabState} */
  #snapshot() {
    const values = this.#emu.registers();
    const active = this.#trail.slice(0, this.#emu.history.position);
    return {
      reg: (index) => values[index] ?? 0,
      word: (address) => {
        try {
          const b = this.#emu.readMemory(address, 4);
          return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
        } catch {
          return 0;
        }
      },
      pc: this.#emu.pc,
      used: this.#used,
      writer: (index) => active.findLast((entry) => entry.registers.has(index))?.token,
      wrote: (token, index) => active.some((entry) => entry.token === token && entry.registers.has(index)),
    };
  }

  /**
   * Updates the checklist and, when allowed, records completion.
   * @param {boolean} canComplete False unless the user just changed machine
   *   state, so leftover state or a read-only command never completes a lesson.
   */
  #evaluate(canComplete) {
    const lesson = LESSONS[this.#current];
    const state = this.#snapshot();
    const results = lesson.challenge.checks.map((check) => {
      try {
        return check.test(state);
      } catch {
        return false;
      }
    });
    results.forEach((passed, i) => {
      el.checks.children[i]?.classList.toggle('passed', passed);
    });

    if (canComplete && !this.#progress.completed.includes(this.#current) && results.every(Boolean)) {
      this.#progress.completed.push(this.#current);
      saveProgress(this.#progress);
      this.#repl.print(`✓ Challenge complete: ${lesson.challenge.prompt}`, 'ok');
    }
    const done = this.#progress.completed.includes(this.#current);
    el.challenge.classList.toggle('complete', done);
    if (done && !el.challenge.querySelector('.challenge-done')) {
      const note = document.createElement('p');
      note.className = 'challenge-done';
      note.textContent = 'Done. Nice work.';
      el.challengePrompt.after(note);
    }
    this.#updateTabs();
    this.#renderNav();
  }

  /** Creates the step tabs once; {@link Lab#updateTabs} keeps them current. */
  #buildTabs() {
    this.#tabButtons = LESSONS.map((lesson, i) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'tab';
      const number = document.createElement('span');
      number.className = 'tab-number';
      number.textContent = pad(i + 1);
      const name = document.createElement('span');
      name.className = 'tab-name';
      name.textContent = lesson.tab;
      tab.append(number, name);
      tab.addEventListener('click', () => this.open(i));
      return tab;
    });
    el.tabs.replaceChildren(...this.#tabButtons);
    el.progressBoxes.replaceChildren(...LESSONS.map(() => document.createElement('li')));
  }

  /** Updates tab state and the progress meter in place (keeps focus). */
  #updateTabs() {
    const completed = new Set(this.#progress.completed);
    this.#tabButtons.forEach((tab, i) => {
      tab.classList.toggle('done', completed.has(i));
      if (i === this.#current) tab.setAttribute('aria-current', 'step');
      else tab.removeAttribute('aria-current');
      tab.setAttribute('aria-label', `Step ${i + 1}: ${LESSONS[i].tab}${completed.has(i) ? ' (complete)' : ''}`);
    });
    [...el.progressBoxes.children].forEach((box, i) => box.classList.toggle('done', completed.has(i)));
    const label = `${completed.size} / ${LESSONS.length} complete`;
    // Only touch the live region when the value changes, so screen readers
    // don't re-announce it after every command.
    if (el.progressLabel.textContent !== label) el.progressLabel.textContent = label;
  }

  #renderNav() {
    const index = this.#current;
    const last = index === LESSONS.length - 1;
    const done = this.#progress.completed.includes(index);
    this.#setDisabled(el.prevStep, index === 0);
    this.#setDisabled(el.nextStep, last);
    el.nextStep.textContent = last
      ? (new Set(this.#progress.completed).size === LESSONS.length ? 'All steps complete' : 'Last step')
      : (done ? 'Next step →' : 'Skip to next step');
  }
}

try {
  const emulator = await Emulator.create();
  new Lab(emulator);
} catch (error) {
  el.log.textContent = `Couldn't start the emulator: ${error instanceof Error ? error.message : String(error)}`;
  el.log.classList.add('err');
}
