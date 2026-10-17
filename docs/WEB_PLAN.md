# Brubeck on the Web — Plan

Run the Brubeck RV32I emulator in the browser: the Rust core is compiled to WebAssembly and driven by a fully documented ES module front end, deployed on GitHub Pages.

**Estimate:** 4–5 focused days for a polished version. Phases 0 and 1 (about 1.5 days) prove the whole pipeline end to end.

---

## Status — round 1 (2026-10-16)

On branch `web` of `JCTec/brubeck`. Done:

- **Phase 0 — core fixes:** complete. `cli` feature; memory-edge panics, PC overflow, doubled JAL/branch offsets, misaligned taken branches; `LI` is one atomic history step; memory tracked in `store()` (~0.9 ms → 6.5 µs per instruction, independent of memory size); failed instructions leave no partial state; CSR instructions advance the PC. Regression suite in `tests/robustness.rs`. The project's gate (`fmt`, `clippy -D warnings`, `test`) passes.
- **Phase 1 — wasm wrapper:** complete. `crates/brubeck-wasm` uses only wasm-bindgen primitives (no serde, a change from the original plan); conversion logic is plain Rust, unit-tested natively. `interpreter::Error` is now public so errors carry a stable `kind` and the fuzzy `suggestion`. History position and length are exposed.
- **Phase 2 — web app:** replaced by **Brubeck Lab**, following the design PDF: six guided lessons with click-to-paste examples and self-checking challenges, a REPL with a live register panel and history controls, saved progress, and a stacked layout on phones. Lesson content lives in `web/js/lessons.js`. The timeline scrubber and a separate memory panel are deferred; `/memory` covers memory for now.
- **Phase 3 — CI and Pages:** workflow written; staged at `ci/web.yml` because remote tools can't write to `.github/`.

Not yet verified anywhere: the real `wasm32` / `wasm-pack` build (blocked in the build sandbox). The first CI run on GitHub is that proof.

Known follow-ups: hex literals above `0x7FFFFFFF` (e.g. `LI x2, 0xDEADBEEF`) are rejected by the parser; the AccessViolation tip always says "1MB" regardless of the configured memory size.

## Status — round 2, Phase A: verified with the real toolchain (2026-10-16)

Everything round 1 couldn't build was built and run locally (Rust 1.99.1, wasm-pack with wasm-bindgen 0.2.129, Node 26, Chromium via Playwright):

- **REPL binary** with real clap/crossterm: builds; `-e`/`-v` output and interactive `/p`, `/n` checked by eye (through a pty). `LI` steps back as one entry; the memory-byte count reads "4 memory bytes changed" for `SW`.
- **Bindings:** the generated `.d.ts` matches everything `brubeck.js` assumes; failures throw the `RawError` instance. **`.wasm`: 151 KB raw, 55 KB gzipped** (target < 150 KB).
- **Web app on the real wasm:** `tsc --checkJs` is clean, and all 19 checks in `tests/lab.e2e.mjs` pass on the first run. Checked by eye at 1280 px and 390 px against the design PDF, and keyboard-only.

Found broken and fixed:

- `cargo clippy -D warnings` failed on the binary (a new `collapsible_match` lint in clippy 1.99). Fixed with match guards, which behave the same here.
- `npm run docs` exited 1: JSDoc can't parse the TypeScript type syntax that `checkJs` code uses (23 sites). Docs now come from **TypeDoc** (departs from the plan's "JSDoc site"), which reads the same comments through the TypeScript compiler, so the docs and the type check can't disagree.
- Keyboard focus: the scrollable register panel had the default focus ring in Chrome and wasn't reachable at all in Safari; the prompt had `outline: 0`. Both now have design-coloured focus indicators.

Departures:

- Lesson 3's tab is **"History"**, not "Undo" as in the design PDF, and lesson text says "step back" rather than "undo". CLAUDE.md's naming rule takes precedence over the mock-up.
- CI installs with `npm ci` (lockfile committed) and runs the e2e test after the type check.
- `Cargo.lock` didn't change: it already had the wasm-bindgen entries.
- Not done: a VoiceOver pass. The accessibility tree (landmarks, names, the `log` live region) was checked through Playwright instead.

Shipped: PR [#1](https://github.com/JCTec/brubeck/pull/1) merged into `main` (a merge commit) after CI passed; Pages enabled with GitHub Actions as the source; the deploy job ran, and **https://jctec.github.io/brubeck/** serves the lab, the `.wasm` (gzipped, `application/wasm`) and both API docs. A run-through on the live site (instructions, `/m`, `/p`, no page errors) passed. Also in that PR: CI runs once per change (`push` only for `main`, plus `pull_request`) on current action majors (no Node 20 warnings), and the pointless `.nojekyll` was dropped.

## Status — round 2, Phase B: polish (2026-10-16)

Branch `polish`, PR #2. Every item in the brief is done, including the optional one:

- **Unsigned immediates.** `LI` takes any 32-bit pattern (`0xDEADBEEF`, `0xFFFFFFFF`, `4294967295`, down to `-0x80000000`). `LUI`/`AUIPC` take `0..0xFFFFF`. 12-bit immediates stay signed (`ADDI x1, x0, 0xFFF` is an error). Numbers parse to `i64` bounded to `i32::MIN..=u32::MAX`, and each instruction checks its own range, so `ADDI x1, x0, 0xFFFFFFFF` is rejected and reported as 4294967295, not silently treated as -1. Tests in `tests/parser.rs`.
- **Size-neutral AccessViolation tip** in the library; the REPL appends the real size ("This REPL has 4K of memory…").
- **History timeline:** `Interpreter::go_to(position)` (tests in `tests/history_navigation/`) returns the net change, exposed as `Emulator.goTo`. The scrubber in the REPL bar is a styled `<input type="range">` labelled by the "History n / m" pill, works from the keyboard, and highlights the net change of the whole drag, logged as one line.
- **Memory panel:** a "Registers | Memory" tab switcher in the dark panel; a 64-byte hex grid around the last memory change (or the PC), with changed bytes highlighted and an address field to pin the view.
- **Share by URL:** "Share" prints and copies a `#step=…&run=…` link of the instructions in effect; opening it replays them (without completing challenges) and clears the hash.
- `.wasm`: **156 KB raw, 57 KB gzipped**.

Also found and fixed:

- Negative hex/binary (`-0x10`) was an "Invalid token" error, although the parser's docs promised it.
- With tips off, the REPL removed only the first line of a multi-line tip ("Common causes: …" leaked through).
- The lab had lost the upstream credit and the API docs links when the design replaced the smoke page; both are back in a colophon. The README links the live site.
- Changed registers and bytes were marked by colour alone; they now also carry screen-reader text.

Departures from the brief:

- **Negative `LUI`/`AUIPC` immediates are now rejected** (before, -524288..524287 was accepted). The brief asked for "0..0xFFFFF, matching GNU as", and GNU as rejects negatives. Nothing in the repo or lessons used them.
- `ImmediateOutOfRange.value` is `i64` in both `interpreter::Error` and `ParseError`, a small public API change, so errors report the value as typed.
- `go_to` past the end returns the existing `HistoryError::AtEnd` rather than a new variant, which would have broken exhaustive matches downstream.
- The memory grid shows 8 bytes per row (8 rows) rather than the usual 16, so it fits a 390 px phone without horizontal scrolling.
- A scrubber move counts as `/p` or `/n` for lesson 3's checks.

Open for JC: the repo has no `LICENSE` file. Upstream declares Apache-2.0 only in `Cargo.toml`, and wasm-pack warns about it. Adding the licence text is a call for the maintainer, so it wasn't done here.

---

---

## Why this is feasible

- The core library has **zero dependencies** and does **no I/O**: no `std::fs`, `std::time`, threads or printing outside tests. That is the ideal case for `wasm32-unknown-unknown`.
- The library already returns data (`StateDelta`) and leaves presentation to the binary. A web front end is just another presentation layer.
- The only build blockers are `clap` and `crossterm`. They are declared as unconditional package dependencies, so they would be compiled for the wasm target. Fixed in Phase 0.

> Not yet verified: an actual `wasm32` build. The target couldn't be downloaded in the analysis environment. Phase 1 is the proof.

---

## Architecture

```
brubeck/                      fork of peat/brubeck, as a Cargo workspace
├── src/                      core library (pure, zero-dependency)
├── crates/
│   └── brubeck-wasm/         thin wasm-bindgen wrapper (~150 lines of Rust)
├── web/                      static site: native ES modules, no framework, no bundler
│   ├── index.html
│   ├── css/
│   ├── js/
│   │   ├── app.js            bootstrap: load wasm, wire up modules
│   │   ├── repl.js           console input, arrow-key command history
│   │   ├── commands.js       /regs, /memory, /previous, /next, /reset, /help
│   │   ├── registers.js      register panel, highlights changes from the delta
│   │   ├── memory.js         hex view
│   │   └── history.js        timeline scrubber over state history
│   ├── pkg/                  wasm-pack output (generated in CI, git-ignored)
│   ├── jsconfig.json         checkJs configuration
│   └── jsdoc.json
└── .github/workflows/pages.yml
```

**Flow:** Rust core → `wasm-pack build --target web` → ES module + `.wasm` + `.d.ts` → `import init, { Interpreter } from './pkg/brubeck_wasm.js'` → static files on GitHub Pages.

---

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Repository | Fork `peat/brubeck` and add `web/`; no separate Pages repo, no submodule | One CI run builds and deploys; the Rust and JS versions always match. Submodules add friction for no gain. |
| License | Keep Apache-2.0 `LICENSE`; credit the upstream author in the site footer and README | Required by the license, and the right thing to do. |
| Wasm boundary | Separate `brubeck-wasm` crate holds `wasm-bindgen`, `serde` and `serde-wasm-bindgen` | The core keeps its zero-dependency rule; the wrapper is the only code that knows about JavaScript. |
| Data crossing the boundary | `StateDelta` and errors come back as plain JS objects | Simple to consume and document; no wrapper classes. |
| Memory reads | `readMemory(addr, len)` returns a **copied** `Uint8Array` | Views into wasm memory break silently when it grows; the UI only shows a few hundred bytes. |
| Slash commands | Reimplemented in `commands.js` | They live in the console binary, not the library. That's correct under the project's architecture: they are presentation logic. |
| JS documentation | JSDoc on every module, function and typedef, checked by `tsc --checkJs --noEmit` in CI | "Fully documented" that can't drift. Imports the generated `.d.ts`, so calls into Rust are type-checked without writing TypeScript. |
| API docs hosting | App at `/`, JS docs at `/docs/js/`, Rust docs at `/docs/rust/` | One site, one deploy. |
| Bundler | None | Native ES modules are supported everywhere that matters, and the site stays transparent and easy to read. |

---

## Wasm API sketch

```rust
// crates/brubeck-wasm/src/lib.rs
#[wasm_bindgen]
pub struct Interpreter { inner: brubeck::interpreter::Interpreter }

#[wasm_bindgen]
impl Interpreter {
    #[wasm_bindgen(constructor)]
    pub fn new(memory_size: usize, history_limit: usize) -> Interpreter;

    /// Returns a StateDelta object, or throws { kind, message, suggestion }.
    pub fn interpret(&mut self, input: &str) -> Result<JsValue, JsValue>;
    pub fn previous(&mut self) -> Result<JsValue, JsValue>;
    pub fn next(&mut self) -> Result<JsValue, JsValue>;
    pub fn reset(&mut self);

    pub fn registers(&self) -> Vec<u32>;              // x0..x31
    #[wasm_bindgen(getter)] pub fn pc(&self) -> u32;
    #[wasm_bindgen(js_name = readMemory)]
    pub fn read_memory(&self, addr: u32, len: u32) -> Result<Vec<u8>, JsValue>;
    #[wasm_bindgen(js_name = memorySize)]
    pub fn memory_size(&self) -> usize;
}
```

```js
// web/js/types.js — JSDoc typedefs mirroring the Rust side
/**
 * @typedef {Object} StateDelta
 * @property {Array<[number, number, number]>} registers  [index, old, new]
 * @property {Array<{addr: number, old: number[], new: number[]}>} memory
 * @property {Array<[number, number, number]>} csrs       [address, old, new]
 * @property {[number, number]} pc                        [old, new]
 */

/**
 * @typedef {Object} BrubeckError
 * @property {string} kind          e.g. "UnknownInstruction", "MemoryOutOfBounds"
 * @property {string} message
 * @property {string|null} suggestion
 */
```

---

## Phases

### Phase 0 — Prepare the core (about 1 day)

These fixes come from the code analysis. A Rust panic in WebAssembly kills the module and forces a page reload, so the crash fixes are blockers, not polish.

- [ ] Put `clap` and `crossterm` behind a `cli` feature (`optional = true`) and add `required-features = ["cli"]` to the `brubeck` binary. **This blocks the wasm build.**
- [ ] Fix the memory-end panics: loads and `store()` must bounds-check the full access width (`addr + width <= len`). Report the effective address in the error, not the base register.
- [ ] Replace `pc += 4` and `imm + pc` with `wrapping_add` (`increment_pc`, the not-taken branch paths, `rv32i_auipc`).
- [ ] Fix the doubled jump offsets typed in text: `build_jtype` and `build_btype` must store `offset / 2`.
- [ ] Make a multi-instruction pseudo-instruction (`LI`) a single merged `StateDelta` and a single history entry.
- [ ] Recommended: track memory writes inside `store()` instead of cloning and comparing all memory in `CPU::execute`. Needed before a "Run" button is practical.
- [ ] Make the project's own check pass again: `cargo fmt && cargo clippy -- -D warnings && cargo test`.
- [ ] Add regression tests that go through `interpret("…")` for jumps and branches, and for memory edges at `len-1`, `len-2` and `len-3`.

**Done when:** `cargo build --lib --target wasm32-unknown-unknown --no-default-features` succeeds and all tests pass.

### Phase 1 — Wrapper and smoke test (about half a day)

- [ ] Convert the repo to a Cargo workspace; add `crates/brubeck-wasm` (`crate-type = ["cdylib", "rlib"]`).
- [ ] Implement the API sketch above, with a structured error conversion.
- [ ] Add `console_error_panic_hook` behind a debug feature so any remaining panic shows a readable stack in the browser console.
- [ ] Minimal `web/index.html` that runs `ADDI x1, x0, 42` and logs the delta.
- [ ] `wasm-pack test --headless --firefox` for the wrapper.

**Done when:** opening the page with a local static server (`python3 -m http.server -d web`) shows the delta in the browser console.

### Phase 2 — The web app (2–3 days)

- [ ] **Console:** input line, output log, arrow-key command history, the same color semantics as the terminal version.
- [ ] **Commands** (`commands.js`): `/regs [x1 x2]`, `/memory [addr] [end]`, `/previous`, `/next`, `/reset`, `/help`.
- [ ] **Register panel:** 32 registers plus the PC, ABI names, hex and decimal; registers changed by the last delta are highlighted.
- [ ] **Memory view:** hex dump around the PC or a chosen address; changed bytes are highlighted.
- [ ] **History timeline:** a scrubber over state history, calling `previous()` and `next()`. This is the web version's main advantage over the terminal.
- [ ] Error display that uses `suggestion` ("Did you mean ADD?").
- [ ] Usable on a phone; light and dark themes.

**Done when:** everything in the README's quick-start session works in the browser.

### Phase 3 — Documentation, CI and deploy (about half a day)

- [ ] `jsconfig.json` with `"checkJs": true` and `"strict": true`; zero type errors.
- [ ] JSDoc site generated to `/docs/js/`; `cargo doc --no-deps` copied to `/docs/rust/`.
- [ ] GitHub Actions workflow (below); enable Pages with the source set to "GitHub Actions".
- [ ] README section: "Try it in the browser", with a link.

```yaml
# .github/workflows/pages.yml
name: Deploy to Pages
on:
  push: { branches: [main] }
  workflow_dispatch:
permissions: { contents: read, pages: write, id-token: write }
concurrency: { group: pages, cancel-in-progress: true }

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with: { targets: wasm32-unknown-unknown }
      - uses: Swatinem/rust-cache@v2
      - run: cargo test --workspace
      - run: cargo install wasm-pack --locked
      - run: wasm-pack build crates/brubeck-wasm --target web --release --out-dir ../../web/pkg
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci --prefix web
      - run: npm run --prefix web typecheck   # tsc --checkJs --noEmit
      - run: npm run --prefix web docs        # jsdoc -> web/docs/js
      - run: cargo doc --no-deps -p brubeck && cp -r target/doc web/docs/rust
      - uses: actions/upload-pages-artifact@v3
        with: { path: web }
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment: { name: github-pages, url: "${{ steps.d.outputs.page_url }}" }
    steps:
      - id: d
        uses: actions/deploy-pages@v4
```

GitHub Pages already serves `.wasm` as `application/wasm`, so `WebAssembly.instantiateStreaming` works without extra configuration.

**Done when:** a push to `main` publishes the app and both sets of docs.

### Phase 4 — Extras (after launch)

- [ ] Session encoded in the URL hash: a link reproduces your exact sequence of instructions. Useful for teaching.
- [ ] Multi-line program editor with **Step** and **Run** (needs the Phase 0 memory-tracking fix).
- [ ] Verify execution against the official `riscv-tests` RV32I suite.
- [ ] CSR panel.
- [ ] Offer the work upstream to `peat/brubeck` as a PR.

---

## Risks

| Risk | Mitigation |
|---|---|
| A remaining panic kills the wasm module | Phase 0 fixes, plus the panic hook; the front end catches a trap and offers "Reload emulator" without reloading the page. |
| Bundle size | The core is small; build with `opt-level = "z"`, `lto = true` and `wasm-opt -Oz`. Target: under 150 KB gzipped. |
| JS documentation drifting from the code | `tsc --checkJs` in CI fails the build when JSDoc types don't match usage. |
| Diverging from upstream | Keep core changes as small, separate commits so they can be offered upstream. |

---

## Prerequisites (local)

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # if cargo isn't installed
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
# Node 22+ for the type check and JSDoc tooling
```
