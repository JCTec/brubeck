# Brubeck web

The browser front end for Brubeck: the Rust emulator compiled to WebAssembly
and driven by plain, JSDoc-documented ES modules. No framework, no bundler.

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
npm run docs        # JSDoc site in docs/js/
```

## Layout

| Path | Purpose |
|---|---|
| `js/brubeck.js` | Public API: `Emulator`, `BrubeckError`, `StateDelta` typedefs |
| `js/smoke.js` | Phase 1 smoke-test console |
| `pkg/` | wasm-pack output (generated, not committed) |
