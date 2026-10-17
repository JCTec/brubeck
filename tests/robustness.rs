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
    let mut lw = brubeck::rv32_i::IType {
        rd: Register::X2,
        rs1: Register::X1,
        ..Default::default()
    };
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
    let mut cpu = CPU::new(MEM);
    cpu.pc = 0xFFFF_FFFC;
    cpu.execute(Instruction::NOP).unwrap();
    assert_eq!(cpu.pc, 0);
}

#[test]
fn not_taken_branch_wraps_pc() {
    let mut cpu = CPU::new(MEM);
    cpu.pc = 0xFFFF_FFFC;
    cpu.set_register(Register::X1, 1);
    let mut beq = brubeck::rv32_i::BType {
        rs1: Register::X0,
        rs2: Register::X1,
        ..Default::default()
    };
    beq.imm.set_signed(4).unwrap();
    cpu.execute(Instruction::BEQ(beq)).unwrap();
    assert_eq!(cpu.pc, 0);
}

#[test]
fn auipc_wraps_instead_of_panicking() {
    let mut cpu = CPU::new(MEM);
    cpu.pc = 0x2000;
    let mut auipc = brubeck::rv32_i::UType {
        rd: Register::X1,
        ..Default::default()
    };
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

// --- Multi-instruction pseudo-instructions ---------------------------------

#[test]
fn li_returns_one_combined_delta() {
    let mut i = Interpreter::new();
    let delta = i.interpret("LI x1, 0x12345678").unwrap();
    assert_eq!(delta.register_changes, vec![(Register::X1, 0, 0x1234_5678)]);
    assert_eq!(delta.pc_change, (0, 8));
}

#[test]
fn li_is_a_single_history_entry() {
    let mut i = Interpreter::new();
    i.interpret("LI x1, 0x12345678").unwrap();

    i.previous_state().unwrap();
    assert_eq!(i.cpu.get_register(Register::X1), 0);
    assert_eq!(i.cpu.pc, 0);
    assert!(i.previous_state().is_err(), "LI must be one entry, not two");

    i.next_state().unwrap();
    assert_eq!(i.cpu.get_register(Register::X1), 0x1234_5678);
    assert_eq!(i.cpu.pc, 8);
}

#[test]
fn merged_delta_keeps_first_old_and_last_new_values() {
    use brubeck::rv32_i::{MemoryDelta, StateDelta};
    let first = StateDelta {
        register_changes: vec![(Register::X1, 0, 5), (Register::X2, 7, 8)],
        memory_changes: vec![MemoryDelta {
            addr: 10,
            old_data: vec![0, 0],
            new_data: vec![1, 2],
        }],
        csr_changes: vec![(0x340, 0, 1)],
        pc_change: (0, 4),
    };
    let second = StateDelta {
        register_changes: vec![(Register::X1, 5, 9), (Register::X2, 8, 7)],
        memory_changes: vec![MemoryDelta {
            addr: 11,
            old_data: vec![2],
            new_data: vec![3],
        }],
        csr_changes: vec![(0x340, 1, 2)],
        pc_change: (4, 8),
    };
    let merged = first.merge(second);
    // x2 went 7 -> 8 -> 7: no net change, so it disappears.
    assert_eq!(merged.register_changes, vec![(Register::X1, 0, 9)]);
    assert_eq!(
        merged.memory_changes,
        vec![MemoryDelta {
            addr: 10,
            old_data: vec![0, 0],
            new_data: vec![1, 3]
        }]
    );
    assert_eq!(merged.csr_changes, vec![(0x340, 0, 2)]);
    assert_eq!(merged.pc_change, (0, 8));
}

// --- Delta tracking ---------------------------------------------------------

#[test]
fn store_delta_lists_only_changed_bytes() {
    let mut i = interp();
    i.interpret("LI x1, 0x100").unwrap();
    i.interpret("LI x2, 0x11223344").unwrap();
    let delta = i.interpret("SW x2, 0(x1)").unwrap();
    let bytes: Vec<(u32, u8, u8)> = delta
        .memory_changes
        .iter()
        .flat_map(|m| {
            m.old_data
                .iter()
                .zip(&m.new_data)
                .enumerate()
                .map(move |(k, (&o, &n))| (m.addr + k as u32, o, n))
        })
        .collect();
    assert_eq!(
        bytes,
        vec![
            (0x100, 0, 0x44),
            (0x101, 0, 0x33),
            (0x102, 0, 0x22),
            (0x103, 0, 0x11)
        ]
    );

    // Rewriting the same value changes nothing in memory.
    let delta = i.interpret("SW x2, 0(x1)").unwrap();
    assert!(delta.memory_changes.is_empty());

    // Overwriting one byte reports just that byte.
    i.interpret("ADDI x3, x0, 0x55").unwrap();
    let delta = i.interpret("SB x3, 2(x1)").unwrap();
    assert_eq!(delta.memory_changes.len(), 1);
    assert_eq!(delta.memory_changes[0].addr, 0x102);
    assert_eq!(delta.memory_changes[0].old_data, vec![0x22]);
    assert_eq!(delta.memory_changes[0].new_data, vec![0x55]);
}

#[test]
fn store_history_round_trip() {
    let mut i = interp();
    i.interpret("LI x1, 0x200").unwrap();
    i.interpret("LI x2, -1").unwrap();
    i.interpret("SW x2, 0(x1)").unwrap();
    i.previous_state().unwrap();
    assert!(i.cpu.memory[0x200..0x204].iter().all(|&b| b == 0));
    i.next_state().unwrap();
    assert!(i.cpu.memory[0x200..0x204].iter().all(|&b| b == 0xFF));
}

#[test]
fn apply_rejects_read_only_csr_without_partial_changes() {
    use brubeck::rv32_i::Modify;
    let mut cpu = CPU::new(MEM);
    let modify = Modify {
        register_changes: vec![(Register::X5, 77)],
        memory_changes: vec![(0, vec![1, 2, 3])],
        csr_changes: vec![(0xC00, 5)], // CYCLE is read-only
        pc_change: Some(0x40),
    };
    assert!(cpu.apply(&modify).is_err());
    assert_eq!(cpu.get_register(Register::X5), 0, "registers untouched");
    assert_eq!(&cpu.memory[0..3], &[0, 0, 0], "memory untouched");
    assert_eq!(cpu.pc, 0, "pc untouched");
}

// --- Review findings ------------------------------------------------------

#[test]
fn failing_csr_instruction_leaves_state_unchanged() {
    // CSRRS writes rd before discovering the CSR is read-only; the failed
    // instruction must not leave that write behind (or desync history).
    let mut i = interp();
    i.interpret("ADDI x1, zero, 7").unwrap();
    i.interpret("ADDI x2, zero, 1").unwrap();
    for op in [
        "CSRRS x1, 0xC00, x2",
        "CSRRC x1, 0xC00, x2",
        "CSRRW x1, 0xC00, x2",
    ] {
        assert!(i.interpret(op).is_err(), "{op} targets read-only CYCLE");
        assert_eq!(
            i.cpu.get_register(Register::X1),
            7,
            "{op} must not change x1"
        );
        assert_eq!(i.cpu.pc, 8, "{op} must not move the PC");
    }
    for op in [
        "CSRRSI x1, 0xC00, 1",
        "CSRRCI x1, 0xC00, 1",
        "CSRRWI x1, 0xC00, 1",
    ] {
        assert!(i.interpret(op).is_err(), "{op} targets read-only CYCLE");
        assert_eq!(
            i.cpu.get_register(Register::X1),
            7,
            "{op} must not change x1"
        );
    }
    i.previous_state().unwrap();
    i.previous_state().unwrap();
    assert_eq!(
        i.cpu.get_register(Register::X1),
        0,
        "history still consistent"
    );
}

#[test]
fn csr_instructions_advance_pc() {
    for op in [
        "CSRRW x1, 0x340, x2",
        "CSRRS x1, 0x340, x2",
        "CSRRC x1, 0x340, x2",
        "CSRRWI x1, 0x340, 5",
        "CSRRSI x1, 0x340, 5",
        "CSRRCI x1, 0x340, 5",
    ] {
        let mut i = interp();
        let delta = i.interpret(op).unwrap();
        assert_eq!(delta.pc_change, (0, 4), "{op} must advance the PC by 4");
    }
}

// --- History position -------------------------------------------------------

#[test]
fn history_position_tracks_navigation() {
    let mut i = Interpreter::with_config(MEM, 3);
    assert_eq!((i.history_position(), i.history_len()), (0, 0));
    i.interpret("ADDI x1, zero, 1").unwrap();
    i.interpret("LI x2, 0x12345678").unwrap(); // one entry
    assert_eq!((i.history_position(), i.history_len()), (2, 2));
    i.previous_state().unwrap();
    assert_eq!((i.history_position(), i.history_len()), (1, 2));
    i.interpret("ADDI x3, zero, 3").unwrap(); // discards the steps ahead
    assert_eq!((i.history_position(), i.history_len()), (2, 2));
    i.interpret("NOP").unwrap();
    i.interpret("NOP").unwrap(); // limit 3 drops the oldest
    assert_eq!((i.history_position(), i.history_len()), (3, 3));
    assert!(i.interpret("BOGUS").is_err()); // errors don't record
    assert_eq!((i.history_position(), i.history_len()), (3, 3));
    i.reset();
    assert_eq!((i.history_position(), i.history_len()), (0, 0));
}
