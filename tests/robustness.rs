//! Regression tests for edge cases that used to panic or misbehave.
//!
//! A panic in the library kills the REPL session (and, compiled to
//! WebAssembly, the whole module), so every case here must return a
//! `Result` instead.

use brubeck::interpreter::Interpreter;
use brubeck::rv32_i::{CPUError, Instruction, Register, CPU};

const MEM: usize = 1024;

fn interp() -> Interpreter {
    Interpreter::with_config(MEM, 100)
}

/// Returns an interpreter with x1 set to `addr`.
fn with_x1(addr: u32) -> Interpreter {
    let mut i = interp();
    i.interpret(&format!("LI x1, {}", addr as i32)).unwrap();
    i
}

// --- Memory bounds -------------------------------------------------------

#[test]
fn loads_straddling_end_of_memory_return_error() {
    let cases: &[(&str, u32)] = &[("LW", 4), ("LH", 2), ("LHU", 2)];
    for &(op, width) in cases {
        for addr in (MEM as u32 - width + 1)..(MEM as u32) {
            let mut i = with_x1(addr);
            let result = i.interpret(&format!("{op} x2, 0(x1)"));
            assert!(
                result.is_err(),
                "{op} at {addr} should fail, got {result:?}"
            );
        }
    }
}

#[test]
fn loads_fitting_exactly_at_end_of_memory_succeed() {
    for &(op, width) in &[("LW", 4u32), ("LH", 2), ("LHU", 2), ("LB", 1), ("LBU", 1)] {
        let mut i = with_x1(MEM as u32 - width);
        assert!(
            i.interpret(&format!("{op} x2, 0(x1)")).is_ok(),
            "{op} ending exactly at the last byte should succeed"
        );
    }
}

#[test]
fn stores_straddling_end_of_memory_return_error_and_write_nothing() {
    for &(op, width) in &[("SW", 4u32), ("SH", 2)] {
        for addr in (MEM as u32 - width + 1)..(MEM as u32) {
            let mut i = with_x1(addr);
            i.interpret("LI x2, -1").unwrap();
            let result = i.interpret(&format!("{op} x2, 0(x1)"));
            assert!(result.is_err(), "{op} at {addr} should fail");
            assert!(
                i.cpu.memory[addr as usize..].iter().all(|&b| b == 0),
                "{op} at {addr} must not partially write memory"
            );
        }
    }
}

#[test]
fn stores_fitting_exactly_at_end_of_memory_succeed() {
    for &(op, width) in &[("SW", 4u32), ("SH", 2), ("SB", 1)] {
        let mut i = with_x1(MEM as u32 - width);
        i.interpret("LI x2, -1").unwrap();
        assert!(i.interpret(&format!("{op} x2, 0(x1)")).is_ok());
        assert!(i.cpu.memory[MEM - width as usize..]
            .iter()
            .all(|&b| b == 0xFF));
    }
}

#[test]
fn access_violation_reports_effective_address() {
    let mut cpu = CPU::new(MEM);
    cpu.set_register(Register::X1, 1000);
    let mut lw = brubeck::rv32_i::IType::new();
    lw.rd = Register::X2;
    lw.rs1 = Register::X1;
    lw.imm.set_signed(100).unwrap();
    match cpu.execute(Instruction::LW(lw)) {
        Err(CPUError::AccessViolation(addr)) => assert_eq!(addr, 1100),
        other => panic!("expected AccessViolation(1100), got {other:?}"),
    }
}

#[test]
fn access_at_top_of_address_space_does_not_overflow() {
    // 0xFFFFFFFF + width overflows u32; must be an error, not a panic.
    let mut i = interp();
    i.interpret("LI x1, -1").unwrap();
    assert!(i.interpret("LW x2, 0(x1)").is_err());
    assert!(i.interpret("SW x2, 0(x1)").is_err());
}

// --- PC arithmetic -------------------------------------------------------

#[test]
fn pc_wraps_instead_of_panicking() {
    let mut cpu = CPU::default();
    cpu.pc = 0xFFFF_FFFC;
    cpu.execute(Instruction::NOP).unwrap();
    assert_eq!(cpu.pc, 0);
}

#[test]
fn not_taken_branch_wraps_pc() {
    let mut cpu = CPU::default();
    cpu.pc = 0xFFFF_FFFC;
    cpu.set_register(Register::X1, 1);
    let mut beq = brubeck::rv32_i::BType::new();
    beq.rs1 = Register::X0;
    beq.rs2 = Register::X1;
    beq.imm.set_signed(4).unwrap();
    cpu.execute(Instruction::BEQ(beq)).unwrap();
    assert_eq!(cpu.pc, 0);
}

#[test]
fn auipc_wraps_instead_of_panicking() {
    let mut cpu = CPU::default();
    cpu.pc = 0x2000;
    let mut auipc = brubeck::rv32_i::UType::new();
    auipc.rd = Register::X1;
    auipc.imm.set_signed(-1).unwrap(); // 0xFFFFF000 after the shift
    cpu.execute(Instruction::AUIPC(auipc)).unwrap();
    assert_eq!(cpu.get_register(Register::X1), 0x1000);
}

// --- Jump and branch offsets typed as text ---------------------------------
//
// Assembly offsets are byte offsets; the encoded immediate is in units of
// 2 bytes. The text path must halve the value exactly once.

#[test]
fn jal_text_offset_is_in_bytes() {
    let mut i = interp();
    i.interpret("JAL x1, 8").unwrap();
    assert_eq!(i.cpu.pc, 8);
    assert_eq!(i.cpu.get_register(Register::X1), 4);
}

#[test]
fn jal_x0_matches_j_pseudo_instruction() {
    let mut a = interp();
    let mut b = interp();
    a.interpret("JAL x0, 12").unwrap();
    b.interpret("J 12").unwrap();
    assert_eq!(a.cpu.pc, b.cpu.pc);
}

#[test]
fn jal_backward_text_offset() {
    let mut i = Interpreter::new();
    for _ in 0..4 {
        i.interpret("NOP").unwrap(); // pc = 16
    }
    i.interpret("JAL x0, -8").unwrap();
    assert_eq!(i.cpu.pc, 8);
}

#[test]
fn jal_accepts_full_byte_offset_range() {
    let mut i = Interpreter::new();
    assert!(i.interpret("JAL x0, 1048572").is_ok());
    assert_eq!(i.cpu.pc, 1048572);
    assert!(i.interpret("JAL x0, 1048576").is_err());
}

#[test]
fn branch_text_offsets_are_in_bytes() {
    for op in ["BEQ x0, x0", "BGE x0, x0", "BGEU x0, x0"] {
        let mut i = interp();
        i.interpret(&format!("{op}, 8")).unwrap();
        assert_eq!(i.cpu.pc, 8, "{op}, 8 should land on 8");
    }
    let mut i = interp();
    i.interpret("ADDI x1, x0, 1").unwrap(); // pc = 4
    for op in ["BNE x0, x1", "BLT x0, x1", "BLTU x0, x1"] {
        let before = i.cpu.pc;
        i.interpret(&format!("{op}, 12")).unwrap();
        assert_eq!(i.cpu.pc, before + 12, "{op}, 12");
    }
}

#[test]
fn branch_accepts_full_byte_offset_range() {
    let mut i = Interpreter::new();
    assert!(i.interpret("BEQ x0, x0, 4092").is_ok());
    assert_eq!(i.cpu.pc, 4092);
    assert!(i.interpret("BEQ x0, x0, 4096").is_err());
}

#[test]
fn taken_branch_to_misaligned_target_is_an_error() {
    let mut i = interp();
    let result = i.interpret("BEQ x0, x0, 6");
    assert!(result.is_err(), "target 6 is not 4-byte aligned");
    assert_eq!(i.cpu.pc, 0, "PC must not change on a faulting branch");
}

#[test]
fn not_taken_branch_ignores_misaligned_target() {
    let mut i = interp();
    i.interpret("ADDI x1, x0, 1").unwrap();
    assert!(i.interpret("BEQ x0, x1, 6").is_ok());
    assert_eq!(i.cpu.pc, 8);
}
