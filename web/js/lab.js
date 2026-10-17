// @ts-check
/**
 * Brubeck Lab: wires the lessons, the REPL, the register panel and progress
 * tracking together. Entry point loaded by `index.html`.
 * @module lab
 */

import { Emulator, BrubeckError } from './brubeck.js';
import { LESSONS } from './lessons.js';
import { Repl, destinationRegister } from './repl.js';
import { renderRegisters } from './registers.js';

/** @typedef {import('./lessons.js').LabState} LabState */
/** @typedef {import('./repl.js').StepEvent} StepEvent */

const STORAGE_KEY = 'brubeck-lab:v1';

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
  registers: $('registers', HTMLElement),
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
  /** @type {HTMLButtonElement[]} */ #tabButtons = [];
  /** History position when the current scrubber gesture began, or null. */
  /** @type {number | null} */ #scrubFrom = null;

  /** @param {Emulator} emulator */
  constructor(emulator) {
    this.#emu = emulator;
    this.#repl = new Repl(emulator, el, (event) => this.#onStep(event));

    el.btnPrev.addEventListener('click', () => this.#repl.run('/p'));
    el.btnNext.addEventListener('click', () => this.#repl.run('/n'));
    el.btnReset.addEventListener('click', () => this.#repl.run('/reset'));
    el.btnClear.addEventListener('click', () => this.#repl.clear());
    // `input` fires while dragging and per arrow key; `change` once the move ends.
    el.scrubber.addEventListener('input', () => this.#scrub(false));
    el.scrubber.addEventListener('change', () => this.#scrub(true));
    el.prevStep.addEventListener('click', () => this.open(this.#progress.current - 1));
    el.nextStep.addEventListener('click', () => this.open(this.#progress.current + 1));
    el.hintToggle.addEventListener('click', () => this.#toggleHint());

    this.#buildTabs();
    this.#repl.print('Brubeck: A RISC-V REPL');
    this.#repl.print('Type an instruction and press Enter. /help lists commands.');
    this.open(this.#progress.current);
    this.#refreshMachine();
    this.#repl.enable();
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
    if (event.delta) this.#changed = event.delta.registers.map((r) => r.index);

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
      this.#trail.push({ token: event.token, registers });
      // The history limit drops the oldest entries; drop them here too.
      while (this.#trail.length > length) this.#trail.shift();
    } else if (event.kind === 'reset') {
      this.#trail = [];
      this.#changed = [];
    }

    this.#refreshMachine();
    // Only actions that change machine state can complete a challenge;
    // inspecting (/regs, /help, /memory) never does.
    const changesState = event.kind === 'instruction' || event.kind === 'previous' || event.kind === 'next';
    this.#evaluate(changesState);
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
      this.#changed = delta.registers.map((r) => r.index);
      this.#refreshMachine();
      return;
    }
    this.#scrubFrom = null;
    if (to === from) this.#refreshMachine();
    else this.#repl.reportMove(delta, from, to);
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
    this.#changed = [];
    this.#repl.print('The emulator was restarted. Registers, memory and history were reset.', 'tip');
    this.#refreshMachine();
    this.#evaluate(false);
  }

  /** Redraws registers, PC and history controls from the emulator. */
  #refreshMachine() {
    renderRegisters(el.registers, el.pcValue, this.#emu.registers(), this.#emu.pc, this.#changed);
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
