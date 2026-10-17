//! Error formatting with helpful context and tips

use brubeck::interpreter::Error;
use brubeck::{CPUError, HistoryError};
use std::io;

/// Formats an interpreter error, adding what only the REPL knows: the
/// configured memory size (the library's message is size-neutral).
pub fn format_interpreter_error(error: &Error, memory_size: usize) -> String {
    let mut output = error.to_string();
    if let Error::Cpu(CPUError::AccessViolation(_)) = error {
        output.push_str(&format!(
            "\n💡 Tip: This REPL has {} of memory (0x00000000 to 0x{:08x}). Start it with --memory to change that.",
            format_memory_size(memory_size),
            memory_size.saturating_sub(1)
        ));
    }
    output
}

/// Formats a byte count the way `--memory` accepts it: `1M`, `256K` or `1000 bytes`.
fn format_memory_size(bytes: usize) -> String {
    const K: usize = 1024;
    match bytes {
        0 => "0 bytes".to_string(),
        b if b % (K * K) == 0 => format!("{}M", b / (K * K)),
        b if b % K == 0 => format!("{}K", b / K),
        b => format!("{b} bytes"),
    }
}

/// Formats a HistoryError
pub fn format_history_error(error: &HistoryError, tips_enabled: bool) -> String {
    let mut output = error.to_string();

    if tips_enabled {
        match error {
            HistoryError::AtBeginning => {
                output.push_str("\n💡 Tip: You're at the beginning of the navigation history. Use --history-limit to increase history size");
            }
            HistoryError::AtEnd => {
                output.push_str("\n💡 Tip: You're at the most recent state. Execute new instructions to continue");
            }
        }
    }

    output
}

/// Formats an IO error with context-specific help
pub fn format_io_error(error: &io::Error, context: &str, tips_enabled: bool) -> String {
    let mut output = format!("{context}: {error}");

    if tips_enabled {
        match error.kind() {
            io::ErrorKind::NotFound => {
                if context.contains("script") {
                    output.push_str(
                        "\n💡 Tip: Check that the script file path is correct and the file exists",
                    );
                }
            }
            io::ErrorKind::PermissionDenied => {
                output.push_str("\n💡 Tip: Check that you have permission to read the file");
            }
            io::ErrorKind::InvalidInput if context.contains("memory") => {
                output
                    .push_str("\n💡 Tip: Valid memory sizes: 1M, 256k, 4096. Use suffixes k/K/m/M");
            }
            _ => {}
        }
    }

    output
}

/// Formats a parse error with helpful examples
pub fn format_parse_error(error: &str, context: &str, tips_enabled: bool) -> String {
    let mut output = error.to_string();

    if tips_enabled && context == "memory_size" {
        output.push_str("\n💡 Tip: Valid memory sizes examples: 1M (1 megabyte), 256k (256 kilobytes), 4096 (4096 bytes)");
    }

    output
}

/// Formats a REPL command error with helpful suggestions
pub fn format_repl_command_error(error: &str, tips_enabled: bool) -> String {
    let mut output = error.to_string();

    if tips_enabled {
        if error.contains("Unknown command") {
            output.push_str("\n💡 Tip: Available commands: /regs, /memory, /previous, /next, /reset, /help, /quit. Use /help for details");
        } else if error.contains("Invalid register") {
            output.push_str("\n💡 Tip: Valid registers: x0-x31, or ABI names like ra, sp, a0, t0. Use /regs to see all");
        } else if error.contains("Invalid address") {
            output.push_str(
                "\n💡 Tip: Addresses can be decimal (100), hex (0x64), or binary (0b1100100)",
            );
        } else if error.contains("Memory range too large") {
            output.push_str(
                "\n💡 Tip: For larger ranges, use multiple /memory commands or adjust the range",
            );
        }
    }

    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use brubeck::HistoryError;
    use std::io;

    #[test]
    fn access_violation_names_the_configured_memory_size() {
        let error = brubeck::interpreter::Error::Cpu(brubeck::CPUError::AccessViolation(0x1000));
        let result = format_interpreter_error(&error, 4096);
        assert!(result.starts_with("Memory address out of bounds: 0x00001000"));
        assert!(result.contains("💡 Tip: This REPL has 4K of memory (0x00000000 to 0x00000fff)"));
        assert!(result.contains("--memory"));

        let result = format_interpreter_error(&error, 1024 * 1024);
        assert!(result.contains("1M of memory (0x00000000 to 0x000fffff)"));
        let result = format_interpreter_error(&error, 1000);
        assert!(result.contains("1000 bytes of memory (0x00000000 to 0x000003e7)"));
    }

    #[test]
    fn other_interpreter_errors_are_unchanged() {
        let error = brubeck::interpreter::Error::Generic("boom".to_string());
        assert_eq!(format_interpreter_error(&error, 4096), "boom");
    }

    #[test]
    fn test_format_history_error() {
        let error = HistoryError::AtBeginning;
        let result = format_history_error(&error, true);
        assert!(result.contains("beginning of the navigation history"));
        assert!(result.contains("💡 Tip:"));
        assert!(result.contains("--history-limit"));
    }

    #[test]
    fn test_format_history_error_no_tips() {
        let error = HistoryError::AtEnd;
        let result = format_history_error(&error, false);
        assert!(result.contains("most recent state"));
        assert!(!result.contains("💡 Tip:"));
    }

    #[test]
    fn test_format_io_error() {
        let error = io::Error::new(io::ErrorKind::NotFound, "file not found");
        let result = format_io_error(&error, "Failed to read script", true);
        assert!(result.contains("Failed to read script"));
        assert!(result.contains("file not found"));
        assert!(result.contains("💡 Tip:"));
        assert!(result.contains("Check that the script file path"));
    }

    #[test]
    fn test_format_parse_error() {
        let result = format_parse_error("Invalid memory size", "memory_size", true);
        assert!(result.contains("Invalid memory size"));
        assert!(result.contains("💡 Tip:"));
        assert!(result.contains("1M"));
        assert!(result.contains("256k"));
    }

    #[test]
    fn test_format_repl_command_error() {
        let result = format_repl_command_error("Unknown command: /foo", true);
        assert!(result.contains("Unknown command"));
        assert!(result.contains("💡 Tip:"));
        assert!(result.contains("Available commands"));
        assert!(result.contains("/help"));
    }
}
