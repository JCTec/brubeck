// @ts-check
/**
 * Brubeck Lab: wires the lessons, the REPL, the register panel and progress
 * tracking together. Entry point loaded by `index.html`.
 * @module lab
 */

import { Emulator } from './brubeck.js';
import { LESSONS } from './lessons.js';
import { Repl } from './repl.js';
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
        completed: raw.completed.filter((/** @type {unknown} */ i) => Number.isInteger(i) && Number(i) >= 0 && Number(i) < LESSONS.length),
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

/** Main controller. */
class Lab {
  /** @type {Emulator} */ #emu;
  /** @type {Repl} */ #repl;
  /** @type {Progress} */ #progress = loadProgress();
  /** Commands and mnemonics run since the current lesson was opened. */
  /** @type {Set<string>} */ #used = new Set();
  /** @type {number[]} */ #changed = [];

  /** @param {Emulator} emulator */
  constructor(emulator) {
    this.#emu = emulator;
    this.#repl = new Repl(emulator, el, (event) => this.#onStep(event));

    el.btnPrev.addEventListener('click', () => this.#repl.run('/p'));
    el.btnNext.addEventListener('click', () => this.#repl.run('/n'));
    el.btnReset.addEventListener('click', () => this.#repl.run('/reset'));
    el.btnClear.addEventListener('click', () => this.#repl.clear());
    el.prevStep.addEventListener('click', () => this.open(this.#progress.current - 1));
    el.nextStep.addEventListener('click', () => this.open(this.#progress.current + 1));
    el.hintToggle.addEventListener('click', () => this.#toggleHint());

    this.#repl.print('Brubeck: A RISC-V REPL');
    this.#repl.print('Type an instruction and press Enter. /help lists commands.');
    this.#renderTabs();
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
    this.#renderTabs();
    this.#renderNav();
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
    if (event.kind === 'error' || event.kind === 'clear') return;
    this.#used.add(event.token);
    if (event.delta) this.#changed = event.delta.registers.map((r) => r.index);
    if (event.kind === 'reset') this.#changed = [];
    this.#refreshMachine();
    this.#evaluate(true);
  }

  /** Redraws registers, PC and history controls from the emulator. */
  #refreshMachine() {
    renderRegisters(el.registers, el.pcValue, this.#emu.registers(), this.#emu.pc, this.#changed);
    const { position, length } = this.#emu.history;
    el.history.textContent = `History ${position} / ${length}`;
    el.btnPrev.disabled = position === 0;
    el.btnNext.disabled = position >= length;
    this.#repl.updatePrompt();
  }

  /** @returns {LabState} */
  #snapshot() {
    const values = this.#emu.registers();
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
    };
  }

  /**
   * Updates the checklist and, when allowed, records completion.
   * @param {boolean} canComplete False when merely opening a lesson, so state
   *   left over from another lesson doesn't complete it without any action.
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

    const alreadyDone = this.#progress.completed.includes(this.#current);
    if (canComplete && !alreadyDone && results.every(Boolean)) {
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
    this.#renderTabs();
    this.#renderNav();
  }

  #renderTabs() {
    const completed = new Set(this.#progress.completed);
    el.tabs.replaceChildren(...LESSONS.map((lesson, i) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = completed.has(i) ? 'tab done' : 'tab';
      if (i === this.#current) tab.setAttribute('aria-current', 'step');
      tab.setAttribute('aria-label', `Step ${i + 1}: ${lesson.tab}${completed.has(i) ? ' (complete)' : ''}`);
      const number = document.createElement('span');
      number.className = 'tab-number';
      number.textContent = pad(i + 1);
      const name = document.createElement('span');
      name.className = 'tab-name';
      name.textContent = lesson.tab;
      tab.append(number, name);
      tab.addEventListener('click', () => this.open(i));
      return tab;
    }));

    el.progressLabel.textContent = `${completed.size} / ${LESSONS.length} complete`;
    el.progressBoxes.replaceChildren(...LESSONS.map((_, i) => {
      const box = document.createElement('li');
      if (completed.has(i)) box.className = 'done';
      return box;
    }));
  }

  #renderNav() {
    const index = this.#current;
    const last = index === LESSONS.length - 1;
    const done = this.#progress.completed.includes(index);
    el.prevStep.disabled = index === 0;
    el.nextStep.disabled = last;
    el.nextStep.textContent = last
      ? (this.#progress.completed.length === LESSONS.length ? 'All steps complete' : 'Last step')
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
