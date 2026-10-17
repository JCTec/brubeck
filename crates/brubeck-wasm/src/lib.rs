//! WebAssembly bindings for the Brubeck RV32I emulator.
//!
//! This crate is deliberately thin: all conversion logic lives in [`convert`]
//! (plain Rust, unit-tested natively), and this file only exposes it through
//! `wasm-bindgen`. Values cross the boundary as numbers, strings and
//! `Uint32Array`/`Uint8Array`s, so no serialization library is needed.
//!
//! JavaScript should use the documented wrapper in `web/js/brubeck.js`, which
//! turns these raw types into plain objects and `BrubeckError` exceptions.

use brubeck::interpreter::Interpreter;
use brubeck::rv32_i::Register;
use wasm_bindgen::prelude::*;

pub mod convert;

use convert::{ErrorParts, FlatDelta};

/// The state changes caused by one step (an instruction, or a history move).
#[wasm_bindgen]
pub struct Delta {
    inner: FlatDelta,
}

#[wasm_bindgen]
impl Delta {
    /// Program counter before the step.
    #[wasm_bindgen(getter, js_name = pcBefore)]
    pub fn pc_before(&self) -> u32 {
        self.inner.pc_before
    }

    /// Program counter after the step.
    #[wasm_bindgen(getter, js_name = pcAfter)]
    pub fn pc_after(&self) -> u32 {
        self.inner.pc_after
    }

    /// Flat `[index, old, new, ...]` triples for changed registers.
    pub fn registers(&self) -> Vec<u32> {
        self.inner.registers.clone()
    }

    /// Flat `[address, oldByte, newByte, ...]` triples for changed memory.
    pub fn memory(&self) -> Vec<u32> {
        self.inner.memory.clone()
    }

    /// Flat `[csrAddress, old, new, ...]` triples for changed CSRs.
    pub fn csrs(&self) -> Vec<u32> {
        self.inner.csrs.clone()
    }
}

/// An error raised by the emulator, thrown to JavaScript.
#[wasm_bindgen]
pub struct RawError {
    parts: ErrorParts,
}

#[wasm_bindgen]
impl RawError {
    /// Stable variant name, e.g. `"UnknownInstruction"` or `"AccessViolation"`.
    #[wasm_bindgen(getter)]
    pub fn kind(&self) -> String {
        self.parts.kind.to_string()
    }

    /// The main error message.
    #[wasm_bindgen(getter)]
    pub fn message(&self) -> String {
        self.parts.message.clone()
    }

    /// Optional educational tip.
    #[wasm_bindgen(getter)]
    pub fn tip(&self) -> Option<String> {
        self.parts.tip.clone()
    }

    /// Optional suggested corrections (e.g. `"ADD or ADDI"` for `"ADDD"`).
    #[wasm_bindgen(getter)]
    pub fn suggestion(&self) -> Option<String> {
        self.parts.suggestion.clone()
    }
}

impl From<ErrorParts> for RawError {
    fn from(parts: ErrorParts) -> Self {
        RawError { parts }
    }
}

fn delta(d: &brubeck::rv32_i::StateDelta) -> Delta {
    Delta {
        inner: convert::flatten(d),
    }
}

/// An RV32I hart with memory and navigable state history.
#[wasm_bindgen]
pub struct Emulator {
    inner: Interpreter,
}

#[wasm_bindgen]
impl Emulator {
    /// Creates an emulator with `memory_size` bytes of memory and room for
    /// `history_limit` steps of history.
    #[wasm_bindgen(constructor)]
    pub fn new(memory_size: usize, history_limit: usize) -> Emulator {
        Emulator {
            inner: Interpreter::with_config(memory_size, history_limit),
        }
    }

    /// Parses and executes one line of assembly.
    pub fn interpret(&mut self, input: &str) -> Result<Delta, RawError> {
        self.inner
            .interpret(input)
            .map(|d| delta(&d))
            .map_err(|e| convert::interpret_error(&e).into())
    }

    /// Steps back one entry in history.
    #[wasm_bindgen(js_name = previous)]
    pub fn previous_state(&mut self) -> Result<Delta, RawError> {
        self.inner
            .previous_state()
            .map(|d| delta(&d))
            .map_err(|e| convert::history_error(&e).into())
    }

    /// Steps forward one entry in history.
    #[wasm_bindgen(js_name = next)]
    pub fn next_state(&mut self) -> Result<Delta, RawError> {
        self.inner
            .next_state()
            .map(|d| delta(&d))
            .map_err(|e| convert::history_error(&e).into())
    }

    /// Clears registers, memory, CSRs and history.
    pub fn reset(&mut self) {
        self.inner.reset();
    }

    /// Current values of x0..x31.
    pub fn registers(&self) -> Vec<u32> {
        (0..32)
            .map(|i| self.inner.cpu.get_register(Register::from_u32(i)))
            .collect()
    }

    /// Current program counter.
    #[wasm_bindgen(getter)]
    pub fn pc(&self) -> u32 {
        self.inner.cpu.pc
    }

    /// Total memory size in bytes.
    #[wasm_bindgen(getter, js_name = memorySize)]
    pub fn memory_size(&self) -> usize {
        self.inner.cpu.memory.len()
    }

    /// Copies `len` bytes starting at `addr`. Fails if the range leaves memory.
    #[wasm_bindgen(js_name = readMemory)]
    pub fn read_memory(&self, addr: u32, len: u32) -> Result<Vec<u8>, RawError> {
        let memory = &self.inner.cpu.memory;
        let start = addr as usize;
        start
            .checked_add(len as usize)
            .filter(|&end| end <= memory.len())
            .map(|end| memory[start..end].to_vec())
            .ok_or_else(|| convert::cpu_error(&brubeck::CPUError::AccessViolation(addr)).into())
    }

    /// Reads a CSR by its 12-bit address.
    #[wasm_bindgen(js_name = readCsr)]
    pub fn read_csr(&self, addr: u16) -> Result<u32, RawError> {
        self.inner
            .cpu
            .read_csr(addr)
            .map_err(|e| convert::cpu_error(&e).into())
    }
}
