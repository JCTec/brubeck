//! Pure conversions from Brubeck's Rust types to flat, JavaScript-friendly data.
//!
//! Nothing in this module touches `wasm-bindgen`, so it compiles and is
//! unit-tested natively (`cargo test -p brubeck-wasm`). `lib.rs` only wraps
//! these values in exported types.

use brubeck::interpreter::Error;
use brubeck::rv32_i::StateDelta;
use brubeck::{CPUError, HistoryError};

/// A [`StateDelta`] flattened into numeric arrays, which cross the wasm
/// boundary as `Uint32Array`s without any serialization.
#[derive(Debug, Clone, PartialEq)]
pub struct FlatDelta {
    pub pc_before: u32,
    pub pc_after: u32,
    /// Triples of `[register index (0-31), old value, new value]`.
    pub registers: Vec<u32>,
    /// Triples of `[address, old byte, new byte]`, one per changed byte.
    pub memory: Vec<u32>,
    /// Triples of `[CSR address, old value, new value]`.
    pub csrs: Vec<u32>,
}

/// Flattens a delta. Memory runs are expanded to one triple per byte so the
/// JavaScript side never has to deal with variable-length records.
pub fn flatten(delta: &StateDelta) -> FlatDelta {
    let registers = delta
        .register_changes
        .iter()
        .flat_map(|(reg, old, new)| [reg.to_u32(), *old, *new])
        .collect();

    let memory = delta
        .memory_changes
        .iter()
        .flat_map(|change| {
            change
                .old_data
                .iter()
                .zip(&change.new_data)
                .enumerate()
                .flat_map(move |(offset, (&old, &new))| {
                    [
                        change.addr.wrapping_add(offset as u32),
                        u32::from(old),
                        u32::from(new),
                    ]
                })
        })
        .collect();

    let csrs = delta
        .csr_changes
        .iter()
        .flat_map(|(addr, old, new)| [*addr, *old, *new])
        .collect();

    FlatDelta {
        pc_before: delta.pc_change.0,
        pc_after: delta.pc_change.1,
        registers,
        memory,
        csrs,
    }
}

/// A library error broken into fields the web UI can render separately.
#[derive(Debug, Clone, PartialEq)]
pub struct ErrorParts {
    /// Stable machine-readable variant name, e.g. `"UnknownInstruction"`.
    pub kind: &'static str,
    /// The main message, without the tip.
    pub message: String,
    /// The educational "💡 Tip" text, if the library provided one.
    pub tip: Option<String>,
    /// Suggested corrections, e.g. `"ADD or ADDI"` for a mistyped `ADDD`.
    pub suggestion: Option<String>,
}

const TIP_MARKER: &str = "💡 Tip:";

/// Splits library display text into the message and the optional tip.
pub fn split_tip(text: &str) -> (String, Option<String>) {
    match text.split_once(TIP_MARKER) {
        Some((message, tip)) => (message.trim().to_string(), Some(tip.trim().to_string())),
        None => (text.trim().to_string(), None),
    }
}

fn parts(kind: &'static str, display: &str, suggestion: Option<String>) -> ErrorParts {
    let (message, tip) = split_tip(display);
    ErrorParts {
        kind,
        message,
        tip,
        suggestion,
    }
}

/// Converts an execution error.
pub fn cpu_error(error: &CPUError) -> ErrorParts {
    let kind = match error {
        CPUError::MisalignedJump(_) => "MisalignedJump",
        CPUError::AccessViolation(_) => "AccessViolation",
        CPUError::EnvironmentCall => "EnvironmentCall",
        CPUError::Breakpoint => "Breakpoint",
        CPUError::IllegalInstruction(_) => "IllegalInstruction",
    };
    parts(kind, &error.to_string(), None)
}

/// Converts an error from [`brubeck::Interpreter::interpret`].
pub fn interpret_error(error: &Error) -> ErrorParts {
    match error {
        Error::Cpu(cpu) => cpu_error(cpu),
        Error::UnknownInstruction { suggestion, .. } => {
            parts("UnknownInstruction", &error.to_string(), suggestion.clone())
        }
        Error::Generic(_) => parts("Generic", &error.to_string(), None),
        Error::UnrecognizedToken(_) => parts("UnrecognizedToken", &error.to_string(), None),
        Error::InvalidRegister { .. } => parts("InvalidRegister", &error.to_string(), None),
        Error::WrongArgumentCount { .. } => parts("WrongArgumentCount", &error.to_string(), None),
        Error::ImmediateOutOfRange { .. } => parts("ImmediateOutOfRange", &error.to_string(), None),
    }
}

/// Converts a history navigation error.
pub fn history_error(error: &HistoryError) -> ErrorParts {
    let kind = match error {
        HistoryError::AtBeginning => "AtBeginning",
        HistoryError::AtEnd => "AtEnd",
    };
    parts(kind, &error.to_string(), None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use brubeck::interpreter::Interpreter;
    use brubeck::rv32_i::{MemoryDelta, Register};

    #[test]
    fn flattens_every_field() {
        let delta = StateDelta {
            register_changes: vec![(Register::X1, 0, 42), (Register::X31, 7, 8)],
            memory_changes: vec![MemoryDelta {
                addr: 0x100,
                old_data: vec![0, 1],
                new_data: vec![0xAA, 0xBB],
            }],
            csr_changes: vec![(0x340, 1, 2)],
            pc_change: (4, 8),
        };
        assert_eq!(
            flatten(&delta),
            FlatDelta {
                pc_before: 4,
                pc_after: 8,
                registers: vec![1, 0, 42, 31, 7, 8],
                memory: vec![0x100, 0, 0xAA, 0x101, 1, 0xBB],
                csrs: vec![0x340, 1, 2],
            }
        );
    }

    #[test]
    fn splits_tip_from_message() {
        assert_eq!(
            split_tip("Bad thing\n💡 Tip: do better\nreally"),
            (
                "Bad thing".to_string(),
                Some("do better\nreally".to_string())
            )
        );
        assert_eq!(split_tip("No tip here"), ("No tip here".to_string(), None));
    }

    #[test]
    fn unknown_instruction_carries_suggestion() {
        let error = Interpreter::new().interpret("ADDD x1, x2, x3").unwrap_err();
        let parts = interpret_error(&error);
        assert_eq!(parts.kind, "UnknownInstruction");
        assert_eq!(parts.suggestion.as_deref(), Some("ADD or ADDI"));
        assert_eq!(
            parts.message,
            "Unknown instruction 'ADDD'. Did you mean 'ADD or ADDI'?"
        );
    }

    #[test]
    fn cpu_errors_map_to_their_kind_and_split_the_tip() {
        let mut interpreter = Interpreter::with_config(1024, 10);
        interpreter.interpret("LI x1, 4096").unwrap();
        let error = interpreter.interpret("LW x2, 0(x1)").unwrap_err();
        let parts = interpret_error(&error);
        assert_eq!(parts.kind, "AccessViolation");
        assert_eq!(parts.message, "Memory address out of bounds: 0x00001000");
        assert!(parts.tip.is_some_and(|tip| !tip.contains(TIP_MARKER)));
    }

    #[test]
    fn history_errors_map_to_their_kind() {
        assert_eq!(
            history_error(&HistoryError::AtBeginning).kind,
            "AtBeginning"
        );
        assert_eq!(history_error(&HistoryError::AtEnd).kind, "AtEnd");
    }
}
