# Brubeck web

Brubeck Lab: a guided, six-step introduction to RISC-V assembly running on the
real Brubeck emulator, compiled from Rust to WebAssembly and driven by plain,
JSDoc-documented ES modules. No framework, no bundler.

## Run locally

```bash
# from the repository root
wasm-pack build crates/brubeck-wasm --target web --out-dir ../../web/pkg
cd web && python3 -m http.server 8000   # open http://localhost:8000
```

## Check and document

```bash
cd web
npm install
npm run typecheck   # tsc --checkJs over js/, using the generated pkg/*.d.ts
npm run docs        # API docs in docs/js/ (TypeDoc, from the same JSDoc types)
```

## Layout

| Path | Purpose |
|---|---|
| `js/brubeck.js` | Public API over the wasm bindings: `Emulator`, `BrubeckError`, `StateDelta` typedefs |
| `js/lessons.js` | The six lessons: text, click-to-paste examples, challenges. Edit content here |
| `js/lab.js` | Entry point: wires lessons, REPL, registers and saved progress together |
| `js/repl.js` | Terminal log and prompt, slash commands (`/regs`, `/memory`, `/p`, `/n`, ...) |
| `js/registers.js` | Register panel rendering |
| `js/memory.js` | Memory panel rendering: 64-byte hex grid around the last write or PC |
| `css/lab.css` | Styles, following the Brubeck Lab design |
| `pkg/` | wasm-pack output (generated, not committed) |
