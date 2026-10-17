# Agent handoff: finish Brubeck Lab

Paste everything below the line into a coding agent (for example, Claude Code) started in `~/Dev/Peat/brubeck` on JC's Mac.

---

You're picking up an in-progress project. Finish it to a shipped, verified state: Brubeck Lab live on GitHub Pages. Then do the round-2 polish. Work autonomously. Make the calls a senior engineer would make, justify them briefly in commit messages, and don't ask for decisions you can make yourself. **Stop and ask the user only before merging to `main` and before enabling GitHub Pages.** Those publish to the world.

## What this is

- `brubeck` is an RV32I RISC-V emulator in Rust. JC forked it from `peat/brubeck` (Apache-2.0) to `JCTec/brubeck`.
- The repo is a Cargo workspace:
  - the zero-dependency core library at the root (`src/`)
  - an optional terminal REPL binary behind the `cli` feature
  - `crates/brubeck-wasm`, the wasm-bindgen bindings
- `web/` holds **Brubeck Lab**: a six-step guided RISC-V tutorial written as plain ES modules with JSDoc, no framework, no bundler.
- Remotes: `origin` is `JCTec/brubeck` and `upstream` is `peat/brubeck`. **Never push to `upstream`.**
- All the work so far is on the local branch **`web`**, 11+ commits ahead of `main`, and not yet pushed.

Read these first, in this order:

1. `CLAUDE.md`: the repo's rules. Write tests first. The quality gate is `cargo fmt`, `cargo clippy -- -D warnings` and `cargo test`. Keep the library pure: no dependencies, no I/O, no formatting. In names and UI, say "previous/next", never "undo/redo".
2. `docs/WEB_PLAN.md`: the plan, plus a "Status — round 1" section describing what's done.
3. `web/README.md`: the layout of the web code.
4. `git log main..web`. The commit messages explain every change and why.

## Why you exist

The previous agent ran in a sandbox without crates.io access and without the wasm toolchain. So three things have **never actually been compiled or run**:

1. the REPL binary with its real `clap`/`crossterm` dependencies, including one small edit in `src/bin/formatting/state_delta.rs` that counts memory bytes
2. `crates/brubeck-wasm` with the real `wasm-bindgen`. Its logic was type-checked against a pass-through stub macro, and `convert.rs` is unit-tested. The bindings themselves have not been built.
3. the web app against the real `.wasm`. It was only tested against a JS test double.

The core library and its 330+ tests did build and pass. So did a strict `tsc --checkJs` and Playwright runs against the double. Assume the gaps hide a few small breakages, and go and find them.

## Phase A: make it real and ship (blocking)

Work on `web`. Keep commits small and descriptive.

1. **Move the CI workflow into place.** Remote tools couldn't write to `.github/`, so it was staged elsewhere.
   ```bash
   git checkout web
   mkdir -p .github/workflows && git mv ci/web.yml .github/workflows/web.yml
   ```
   Delete the two "Move to .github…" comment lines at the top of the file. Remove the empty `ci/` directory.

2. **Rust gate, whole workspace.** This also refreshes `Cargo.lock` with the wasm-bindgen entries; commit it.
   ```bash
   cargo fmt --all --check
   cargo clippy --workspace --all-targets -- -D warnings
   cargo test --workspace
   cargo build --lib --no-default-features --target wasm32-unknown-unknown
   cargo run -- -e "ADDI x1, x0, 42; LI x2, 0x12345678; SW x2, 0(x1); /r x1 x2"
   ```
   The last command checks the CLI by eye. Check that `/p` and `/n` work in the interactive REPL too.

3. **Build the wasm package.**
   ```bash
   wasm-pack build crates/brubeck-wasm --target web --release --out-dir ../../web/pkg
   ```
   Then open `web/pkg/brubeck_wasm.d.ts`. `web/js/brubeck.js` assumes these exports:
   - `Emulator`: constructor `(memory_size, history_limit)`; methods `interpret`, `previous`, `next`, `reset`, `registers`, `readMemory`, `readCsr`; getters `pc`, `memorySize`, `historyPosition`, `historyLength`
   - `Delta`: getters `pcBefore`, `pcAfter`; methods `registers()`, `memory()`, `csrs()` returning `Uint32Array`
   - `RawError`: getters `kind`, `message`, plus `tip` and `suggestion` as `string | undefined`
   - every class has `free()`, and a failed call **throws the `RawError` instance**
   - the default export `init()` works with no arguments

   If anything differs, fix the Rust bindings or the JS wrapper, whichever side is wrong. Report the size of the gzipped `.wasm`. The target is under 150 KB.

4. **JavaScript checks.**
   ```bash
   cd web && npm install && npm run typecheck && npm run docs
   npx playwright install chromium && npm run test:e2e
   ```
   Commit `package-lock.json`. `tests/lab.e2e.mjs` plays through all six lessons against the **real** wasm and checks earlier regressions: layout, LI as one history step, faults that used to panic, JAL offsets, persistence. Every check must pass. If a check fails, decide whether the app or the test is wrong before changing either. Then add an e2e step to the workflow after "Type-check JavaScript":
   ```yaml
   - name: End-to-end test
     working-directory: web
     run: npx playwright install --with-deps chromium && npm run test:e2e
   ```

5. **Look at it.** Run `npm run serve` and open http://localhost:8000.
   - Compare against the design: `~/Dev/Peat/Brubeck_Lab.pdf` if it's there; otherwise ask JC for it.
   - The look is a two-tone layout: `#f3f2f2` paper, `#201e1d` ink, `#ec3013` accent, Archivo ExtraBold/SemiBold, Menlo for code, and 3px rules.
   - Check at 1280px and at 390px, with keyboard only, and with a screen reader if you can (VoiceOver: Cmd+F5).

6. **Push and open the PR against the fork.**
   ```bash
   git push -u origin web
   gh pr create --repo JCTec/brubeck --base main --head web --fill
   gh run watch --repo JCTec/brubeck
   ```
   `--repo` is required. Without it, `gh` targets `peat/brubeck`, because the fork's parent is the default. Fix CI until it's green.

7. **Stop and ask JC** before you:
   - merge the PR
   - enable Pages (Settings → Pages → Source: "GitHub Actions"; or `gh api -X POST repos/JCTec/brubeck/pages -f build_type=workflow`)

   After he approves both, confirm the deploy job ran and that https://jctec.github.io/brubeck/ loads and passes a quick manual run-through.

## Phase B: round-2 polish (new branch off `main` after the merge, separate PR)

Do these in order, TDD for anything in Rust. Design fidelity and accessibility are part of "done": keyboard reachable, visible focus, sensible ARIA, and no layout break at 390px.

1. **Parser: unsigned immediates where assemblers allow them.**
   - `LI x2, 0xDEADBEEF` is rejected today. Hex values above `0x7FFFFFFF` should be accepted as 32-bit two's complement for `LI`.
   - `LUI`/`AUIPC` reject `0x80000`–`0xFFFFF`, such as `LUI x1, 0xFFFFF`. Accept 0..0xFFFFF there, matching GNU as.
   - 12-bit immediates must stay signed. For example, `ADDI x1, x0, 0xFFF` remains an error.
   - Add tests in `tests/robustness.rs` or `tests/parser.rs`.
2. **The AccessViolation tip hard-codes "1MB".** `CPUError`'s `Display` in `src/rv32_i/cpu.rs` says the default memory is 1MB, which is wrong for `--memory` or the web. Make it size-neutral in the library. The REPL binary already knows the size if it wants to say more.
3. **History timeline scrubber in the REPL bar.**
   - A slider from 0 to `history.length` set at `history.position`. Dragging calls `previous()`/`next()` the right number of times.
   - Register highlights should reflect the net change.
   - Prefer adding `Interpreter::go_to(position)` in Rust, with tests, over looping in JS. Expose it through the bindings and `brubeck.js`.
   - It must work from the keyboard. Arrow keys come for free with `<input type="range">`.
   - Style it to the design. Use the "History n / m" pill as its label.
4. **Memory panel.**
   - Add a "Registers | Memory" toggle in the dark panel.
   - Memory view: 64 bytes in a hex grid around the last memory write, or around the PC if there hasn't been one. Bytes changed by the last step are highlighted like registers. Include an address field.
   - Reuse `readMemory` and the per-byte `memory` deltas.
5. **Optional, if time allows: share a session by URL.** Encode the lines run in the URL hash and replay them on load.

## Ground rules

- **Commits:** author them as JC, using git's configured identity. End every commit message with:
  ```
  Co-Authored-By: Claude <noreply@anthropic.com>
  ```
- **Never** force-push, rewrite `main`, push to `upstream`, or commit `web/pkg/`, `web/docs/` or `node_modules/`.
- **Lesson content** lives only in `web/js/lessons.js`. If you change it, run every example and every hint against the real emulator. The e2e test covers the hints.
- **When you finish, reply with:**
  - the PR links and CI status
  - the live URL
  - the wasm size
  - anything you found broken and how you fixed it
  - every decision that departs from this brief or from `docs/WEB_PLAN.md`

  Also update the Status section of `docs/WEB_PLAN.md` with the same information.
