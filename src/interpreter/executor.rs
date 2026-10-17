//! Execution module for running commands and instructions
//!
//! This module handles the execution of parsed commands, including
//! hardware instructions and pseudo-instructions.

use super::types::{Command, Error};
use crate::rv32_i::{Instruction, PseudoInstruction, StateDelta};

/// Executes a command and returns the state delta
///
/// # Command Types
///
/// - **Exec**: Execute a hardware instruction
/// - **ExecPseudo**: Execute a pseudo-instruction
///
/// Note: This is a temporary function that will be removed once we
/// separate parse and execute in the public API
pub fn run_command(
    input: Command,
    interpreter: &mut crate::interpreter::Interpreter,
) -> Result<StateDelta, Error> {
    match input {
        Command::Exec(instruction) => execute_with_tracking(instruction, interpreter),
        Command::ExecPseudo(pseudo) => execute_pseudo(pseudo, interpreter),
    }
}

/// Executes an instruction with delta tracking for undo/redo
///
/// # State Tracking
///
/// This function captures the StateDelta returned by CPU execution,
/// which includes all state changes and records it in history.
///
/// # Arguments
///
/// - `instruction`: The instruction to execute
/// - `interpreter`: The interpreter context
pub fn execute_with_tracking(
    instruction: Instruction,
    interpreter: &mut crate::interpreter::Interpreter,
) -> Result<StateDelta, Error> {
    // Use the interpreter's execute method which handles history recording
    Ok(interpreter.execute(instruction)?)
}

/// Executes a pseudo-instruction by expanding it and running the real instructions
///
/// # Pseudo-instruction Expansion
///
/// Pseudo-instructions are assembly conveniences that expand to one or more
/// real instructions. For example:
/// - `MV x1, x2` expands to `ADDI x1, x2, 0`
/// - `LI x1, 0x12345` may expand to `LUI` + `ADDI` for large values
///
/// # State Tracking
///
/// The whole expansion runs as one atomic step: it returns the combined delta
/// of all executed instructions and records a single history entry, so one
/// `previous_state()` steps back over the entire pseudo-instruction.
pub fn execute_pseudo(
    pseudo: PseudoInstruction,
    interpreter: &mut crate::interpreter::Interpreter,
) -> Result<StateDelta, Error> {
    let instructions = pseudo
        .expand()
        .map_err(|e| Error::Generic(format!("Failed to expand pseudo-instruction: {e}")))?;

    Ok(interpreter.execute_sequence(&instructions)?)
}
