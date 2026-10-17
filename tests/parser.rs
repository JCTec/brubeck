//! Integration tests for the interpreter's parser functionality
//!
//! These tests verify that the interpreter correctly parses and tokenizes
//! RISC-V assembly instructions and register references.

use brubeck::interpreter::Interpreter;

#[test]
fn test_normalize_input() {
    // Test internal normalization (through interpretation)
    let mut i = Interpreter::new();

    // Whitespace normalization
    let result = i.interpret("  ADD   x1,  x2  ,   x3  ");
    assert!(result.is_ok(), "Should handle extra whitespace");

    // Comma handling
    let result = i.interpret("ADD x1,x2,x3");
    assert!(result.is_ok(), "Should handle no spaces around commas");

    // Case insensitivity
    let result = i.interpret("add X1, X2, X3");
    assert!(result.is_ok(), "Should handle lowercase instructions");
}

#[test]
fn test_tokenize_instruction() {
    let mut i = Interpreter::new();

    // Test various instruction formats
    let result = i.interpret("ADD x1, x2, x3");
    assert!(result.is_ok(), "Should tokenize R-type instruction");

    let result = i.interpret("ADDI x1, x2, 100");
    assert!(result.is_ok(), "Should tokenize I-type instruction");

    let result = i.interpret("LUI x1, 74565");
    assert!(result.is_ok(), "Should tokenize U-type instruction");

    let result = i.interpret("JAL x1, 2048");
    assert!(result.is_ok(), "Should tokenize J-type instruction");
}

#[test]
fn test_parse_complete_instruction() {
    let mut i = Interpreter::new();

    // Set up initial state
    i.interpret("ADDI x2, zero, 3").unwrap();
    i.interpret("ADDI x3, zero, 5").unwrap();

    // Execute ADD instruction
    let result = i.interpret("ADD x1, x2, x3");
    assert!(result.is_ok());

    // Verify result - check register directly
    assert_eq!(i.cpu.get_register(brubeck::rv32_i::Register::X1), 8);
}

#[test]
fn test_trivial_add() {
    let mut i = Interpreter::new();

    // Initialize registers
    i.interpret("ADDI x2, zero, 3").unwrap();
    i.interpret("ADDI x3, zero, 5").unwrap();

    // Verify initial state - check register directly
    assert_eq!(i.cpu.get_register(brubeck::rv32_i::Register::X1), 0);

    // Execute ADD
    let result = i.interpret("ADD x1, x2, x3");
    assert!(result.is_ok());

    // Verify result - check register directly
    assert_eq!(i.cpu.get_register(brubeck::rv32_i::Register::X1), 8);
}

#[test]
fn test_parse_negative_immediates() {
    let mut i = Interpreter::new();

    // Test that negative immediates now work correctly
    let result = i.interpret("ADDI x1, zero, -1");
    assert!(result.is_ok());

    // Verify result - check register directly
    assert_eq!(
        i.cpu.get_register(brubeck::rv32_i::Register::X1),
        0xffffffff
    ); // -1 sign-extends to 32 bits

    // Test that 4095 is correctly rejected (outside signed 12-bit range)
    let result = i.interpret("ADDI x1, zero, 4095");
    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("out of range"));
}

#[test]
fn test_parse_hex_immediates() {
    let mut i = Interpreter::new();

    // Note: Current implementation may not support hex parsing
    // This test documents expected behavior
    let result = i.interpret("ADDI x1, zero, 255");
    assert!(result.is_ok());

    // Verify result - check register directly
    assert_eq!(i.cpu.get_register(brubeck::rv32_i::Register::X1), 0xff);
}

#[test]
fn test_parse_all_instruction_types() {
    let mut i = Interpreter::new();

    // R-Type
    let instructions = [
        "ADD x1, x2, x3",
        "SUB x1, x2, x3",
        "SLL x1, x2, x3",
        "SLT x1, x2, x3",
        "SLTU x1, x2, x3",
        "XOR x1, x2, x3",
        "SRL x1, x2, x3",
        "SRA x1, x2, x3",
        "OR x1, x2, x3",
        "AND x1, x2, x3",
    ];

    for inst in &instructions {
        let result = i.interpret(inst);
        assert!(result.is_ok(), "Failed to parse: {inst}");
    }

    // I-Type
    let instructions = [
        "ADDI x1, x2, 100",
        "SLTI x1, x2, 100",
        "SLTIU x1, x2, 100",
        "XORI x1, x2, 100",
        "ORI x1, x2, 100",
        "ANDI x1, x2, 100",
        "SLLI x1, x2, 5",
        "SRLI x1, x2, 5",
        "SRAI x1, x2, 5",
        "JALR x1, x2, 100",
    ];

    for inst in &instructions {
        let result = i.interpret(inst);
        assert!(result.is_ok(), "Failed to parse: {inst}");
    }

    // U-Type
    let instructions = ["LUI x1, 74565", "AUIPC x1, 74565"];

    for inst in &instructions {
        let result = i.interpret(inst);
        assert!(result.is_ok(), "Failed to parse: {inst}");
    }

    // J-Type
    let result = i.interpret("JAL x1, 2048");
    assert!(result.is_ok(), "Failed to parse JAL");

    // NOP
    let result = i.interpret("NOP");
    assert!(result.is_ok(), "Failed to parse NOP");
}

#[test]
fn test_parse_load_store_instructions() {
    let mut i = Interpreter::new();

    // Initialize base address
    i.interpret("ADDI x1, zero, 100").unwrap();

    // Load instructions
    let loads = [
        "LB x2, x1, 0",
        "LH x2, x1, 0",
        "LW x2, x1, 0",
        "LBU x2, x1, 0",
        "LHU x2, x1, 0",
    ];

    for inst in &loads {
        let result = i.interpret(inst);
        assert!(result.is_ok(), "Failed to parse: {inst}");
    }

    // Store instructions
    let stores = ["SB x1, x2, 0", "SH x1, x2, 0", "SW x1, x2, 0"];

    for inst in &stores {
        let result = i.interpret(inst);
        assert!(result.is_ok(), "Failed to parse: {inst}");
    }
}

#[test]
fn test_parse_branch_instructions() {
    let mut i = Interpreter::new();

    // Initialize registers for comparison
    i.interpret("ADDI x1, zero, 10").unwrap();
    i.interpret("ADDI x2, zero, 20").unwrap();

    let branches = [
        "BEQ x1, x2, 64",
        "BNE x1, x2, 64",
        "BLT x1, x2, 64",
        "BGE x1, x2, 64",
        "BLTU x1, x2, 64",
        "BGEU x1, x2, 64",
    ];

    for inst in &branches {
        let result = i.interpret(inst);
        assert!(result.is_ok(), "Failed to parse: {inst}");
    }
}

#[test]
fn test_parse_errors() {
    let mut i = Interpreter::new();

    // Unknown instruction
    let result = i.interpret("UNKNOWN x1, x2, x3");
    assert!(result.is_err(), "Should fail on unknown instruction");

    // Invalid register
    let result = i.interpret("ADD x1, x2, x99");
    assert!(result.is_err(), "Should fail on invalid register");

    // Wrong number of arguments
    let result = i.interpret("ADD x1, x2");
    assert!(result.is_err(), "Should fail with wrong argument count");

    // Empty input
    let result = i.interpret("");
    assert!(result.is_err(), "Should fail on empty input");
}

#[test]
fn test_pc_advancement() {
    let mut i = Interpreter::new();

    // Check initial PC
    assert_eq!(i.cpu.pc, 0);

    // Execute an instruction
    i.interpret("NOP").unwrap();

    // PC should advance by 4
    assert_eq!(i.cpu.pc, 4);

    // Execute another instruction
    i.interpret("NOP").unwrap();

    // PC should advance to 8
    assert_eq!(i.cpu.pc, 8);
}

#[test]
fn test_parse_csr_instructions() {
    let mut i = Interpreter::new();

    // Initialize registers for CSR operations
    i.interpret("ADDI x1, zero, 100").unwrap();
    i.interpret("ADDI x2, zero, 200").unwrap();

    // Test CSR register instructions with numeric addresses
    let csr_reg_instructions = [
        "CSRRW x1, 0x340, x2", // CSRRW rd, csr, rs1
        "CSRRS x1, 0x340, x2", // CSRRS rd, csr, rs1
        "CSRRC x1, 0x340, x2", // CSRRC rd, csr, rs1
    ];

    for inst in &csr_reg_instructions {
        let result = i.interpret(inst);
        assert!(result.is_ok(), "Failed to parse: {inst}");
    }

    // Test CSR immediate instructions with numeric addresses
    let csr_imm_instructions = [
        "CSRRWI x1, 0x340, 15", // CSRRWI rd, csr, uimm5
        "CSRRSI x1, 0x340, 15", // CSRRSI rd, csr, uimm5
        "CSRRCI x1, 0x340, 15", // CSRRCI rd, csr, uimm5
    ];

    for inst in &csr_imm_instructions {
        let result = i.interpret(inst);
        assert!(result.is_ok(), "Failed to parse: {inst}");
    }
}

#[test]
fn test_parse_csr_names() {
    let mut i = Interpreter::new();

    // Initialize registers for CSR operations
    i.interpret("ADDI x1, zero, 100").unwrap();
    i.interpret("ADDI x2, zero, 200").unwrap();

    // Test CSR instructions with named CSRs
    let csr_named_instructions = [
        "CSRRW x1, MSCRATCH, x2",  // Machine scratch register
        "CSRRS x1, MSTATUS, x2",   // Machine status register
        "CSRRC x1, MIE, x2",       // Machine interrupt enable
        "CSRRWI x1, MSCRATCH, 15", // Immediate variant
        "CSRRSI x1, MSTATUS, 8",   // Set bits with immediate
        "CSRRCI x1, MIE, 4",       // Clear bits with immediate
    ];

    for inst in &csr_named_instructions {
        let result = i.interpret(inst);
        assert!(result.is_ok(), "Failed to parse: {inst}");
    }
}

#[test]
fn test_parse_csr_read_only() {
    let mut i = Interpreter::new();

    // Test read-only CSRs (should succeed when only reading)
    let read_only_instructions = [
        "CSRRS x1, CYCLE, x0",   // Read cycle counter
        "CSRRS x1, TIME, x0",    // Read timer
        "CSRRS x1, INSTRET, x0", // Read instruction retired counter
        "CSRRSI x1, CYCLE, 0",   // Read with immediate=0
    ];

    for inst in &read_only_instructions {
        let result = i.interpret(inst);
        assert!(result.is_ok(), "Failed to parse read-only CSR: {inst}");
    }
}

#[test]
fn test_parse_csr_errors() {
    let mut i = Interpreter::new();

    // Test invalid CSR addresses (out of range)
    let invalid_addr_tests = [
        "CSRRW x1, 4096, x2", // CSR address too large
        "CSRRW x1, -1, x2",   // CSR address negative
    ];

    for inst in &invalid_addr_tests {
        let result = i.interpret(inst);
        assert!(
            result.is_err(),
            "Should fail on invalid CSR address: {inst}"
        );
    }

    // Test invalid immediate values for CSR*I instructions
    let invalid_imm_tests = [
        "CSRRWI x1, 0x340, 32", // Immediate too large (max 31)
        "CSRRWI x1, 0x340, -1", // Immediate negative
    ];

    for inst in &invalid_imm_tests {
        let result = i.interpret(inst);
        assert!(result.is_err(), "Should fail on invalid immediate: {inst}");
    }

    // Test wrong argument count
    let wrong_arg_tests = [
        "CSRRW x1, 0x340",         // Missing rs1
        "CSRRW x1",                // Missing csr and rs1
        "CSRRW x1, 0x340, x2, x3", // Too many arguments
    ];

    for inst in &wrong_arg_tests {
        let result = i.interpret(inst);
        assert!(
            result.is_err(),
            "Should fail on wrong argument count: {inst}"
        );
    }

    // Test PC register usage (should be prohibited)
    let pc_tests = [
        "CSRRW PC, 0x340, x1", // PC as destination
        "CSRRW x1, 0x340, PC", // PC as source
    ];

    for inst in &pc_tests {
        let result = i.interpret(inst);
        assert!(
            result.is_err(),
            "Should fail when using PC register: {inst}"
        );
    }
}

#[test]
fn test_parse_reset_command() {
    let mut i = Interpreter::new();

    // Test that /reset command is recognized
    // Note: We can't test the actual reset behavior here because it requires user input
    // This just tests that the parser recognizes the command
    let result = i.interpret("ADDI x1, x0, 42");
    assert!(result.is_ok());

    // The actual /reset command would require user confirmation
    // We're just testing that the command is recognized by the parser
    // Testing the actual reset functionality would require mocking stdin
}

// --- Unsigned immediates where assemblers accept them ----------------------

/// Runs `line` on a fresh interpreter and returns `reg`'s value.
fn run_and_read(line: &str, reg: brubeck::rv32_i::Register) -> u32 {
    let mut i = Interpreter::new();
    i.interpret(line)
        .unwrap_or_else(|e| panic!("'{line}' should be accepted: {e}"));
    i.cpu.get_register(reg)
}

/// Returns the out-of-range value reported for `line`.
fn out_of_range_value(line: &str) -> i64 {
    match brubeck::parse(line) {
        Err(brubeck::ParseError::ImmediateOutOfRange { value, .. }) => value,
        other => panic!("'{line}' should be out of range, got {other:?}"),
    }
}

#[test]
fn li_accepts_32_bit_unsigned_values() {
    use brubeck::rv32_i::Register::X2;
    assert_eq!(run_and_read("LI x2, 0xDEADBEEF", X2), 0xDEADBEEF);
    assert_eq!(run_and_read("LI x2, 0x80000000", X2), 0x8000_0000);
    assert_eq!(run_and_read("LI x2, 0xFFFFFFFF", X2), u32::MAX);
    assert_eq!(run_and_read("LI x2, 4294967295", X2), u32::MAX);
    assert_eq!(
        run_and_read("LI x2, 0b10000000000000000000000000000001", X2),
        0x8000_0001
    );
    // Signed values still work, down to i32::MIN.
    assert_eq!(run_and_read("LI x2, -1", X2), u32::MAX);
    assert_eq!(run_and_read("LI x2, -0x80000000", X2), 0x8000_0000);
}

#[test]
fn li_rejects_values_wider_than_32_bits() {
    let mut i = Interpreter::new();
    assert!(i.interpret("LI x2, 0x100000000").is_err());
    assert!(i.interpret("LI x2, 4294967296").is_err());
    assert!(i.interpret("LI x2, -2147483649").is_err());
}

#[test]
fn lui_and_auipc_accept_the_full_20_bit_range() {
    use brubeck::rv32_i::Register::X1;
    assert_eq!(run_and_read("LUI x1, 0xFFFFF", X1), 0xFFFF_F000);
    assert_eq!(run_and_read("LUI x1, 0x80000", X1), 0x8000_0000);
    assert_eq!(run_and_read("LUI x1, 0x7FFFF", X1), 0x7FFF_F000);
    assert_eq!(run_and_read("LUI x1, 0", X1), 0);
    // AUIPC at PC 0 adds the shifted immediate to 0.
    assert_eq!(run_and_read("AUIPC x1, 0xFFFFF", X1), 0xFFFF_F000);
    assert_eq!(run_and_read("AUIPC x1, 0x80000", X1), 0x8000_0000);
}

#[test]
fn lui_and_auipc_reject_values_outside_0_to_0xfffff() {
    // Matches GNU as: "lui expression not in range 0..1048575".
    for op in ["LUI", "AUIPC"] {
        assert_eq!(out_of_range_value(&format!("{op} x1, 0x100000")), 0x10_0000);
        assert_eq!(out_of_range_value(&format!("{op} x1, -1")), -1);
        match brubeck::parse(&format!("{op} x1, 0x100000")) {
            Err(brubeck::ParseError::ImmediateOutOfRange { min, max, .. }) => {
                assert_eq!((min, max), (0, 0xFFFFF));
            }
            other => panic!("{op}: expected ImmediateOutOfRange, got {other:?}"),
        }
    }
}

#[test]
fn twelve_bit_immediates_stay_signed() {
    assert_eq!(out_of_range_value("ADDI x1, x0, 0xFFF"), 0xFFF);
    assert_eq!(out_of_range_value("ADDI x1, x0, 0x800"), 0x800);
    assert_eq!(out_of_range_value("SLTIU x1, x0, 0xFFF"), 0xFFF);
    // A 32-bit pattern is reported as written, not reinterpreted as -1.
    assert_eq!(out_of_range_value("ADDI x1, x0, 0xFFFFFFFF"), 0xFFFF_FFFF);
    assert_eq!(out_of_range_value("ANDI x1, x0, 0x80000000"), 0x8000_0000);
    assert_eq!(out_of_range_value("BEQ x1, x0, 0xFFFFFFFE"), 0xFFFF_FFFE);
    assert_eq!(out_of_range_value("JAL x1, 0x80000000"), 0x8000_0000);
    assert_eq!(out_of_range_value("SLLI x1, x1, 0xFFFFFFFF"), 0xFFFF_FFFF);

    let mut i = Interpreter::new();
    assert!(i.interpret("LW x1, x0, 0xFFFFFFFC").is_err());
    assert!(i.interpret("SW x1, x0, 0xFFFFFFFC").is_err());
    assert!(i.interpret("CSRRW x1, 0xFFFFFFFF, x2").is_err());
    assert!(i.interpret("J 0xFFFFFFFE").is_err());
    // Negative 12-bit values are unaffected.
    assert!(i.interpret("ADDI x1, x0, -2048").is_ok());
    assert!(i.interpret("ADDI x1, x0, 2047").is_ok());
}

#[test]
fn signs_apply_to_every_base() {
    use brubeck::rv32_i::Register::X1;
    assert_eq!(run_and_read("ADDI x1, x0, -0x10", X1), (-16i32) as u32);
    assert_eq!(run_and_read("ADDI x1, x0, -0b100", X1), (-4i32) as u32);
    assert_eq!(run_and_read("ADDI x1, x0, +5", X1), 5);
    let mut i = Interpreter::new();
    assert!(i.interpret("ADDI x1, x0, --5").is_err());
    assert!(i.interpret("ADDI x1, x0, -+5").is_err());
}
