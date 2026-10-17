//! Basic integration tests for history navigation functionality
//!
//! These tests cover common use cases and basic functionality.

use crate::common::TestContext;
use crate::helpers::HistoryNavigationExt;

#[test]
fn test_history_navigation_basic_arithmetic() {
    let mut ctx = TestContext::new();

    // Execute a sequence of arithmetic instructions
    ctx.exec("ADDI x1, x0, 10")
        .exec("ADDI x2, x0, 20")
        .exec("ADD x3, x1, x2");

    // Verify current state
    ctx.check_reg("x3", "0x0000001e");

    // Navigate back from the ADD
    ctx.previous_expect("ADD").check_reg("x3", "0x00000000");

    // Navigate back from the second ADDI
    ctx.previous().check_reg("x2", "0x00000000");

    // Navigate forward to the second ADDI
    ctx.next_expect("ADDI").check_reg("x2", "0x00000014");

    // Navigate forward to the ADD
    ctx.next().check_reg("x3", "0x0000001e");
}

#[test]
fn test_previous_memory_operations() {
    let mut ctx = TestContext::new();

    // Set up base address and value
    ctx.exec("ADDI x1, x0, 1024") // 0x400
        .exec("LI x2, 0xABCD"); // Use LI for larger value

    // Store to memory
    ctx.exec("SW x2, 0(x1)");

    // Load it back to verify
    ctx.exec("LW x3, 0(x1)").check_reg("x3", "0x0000abcd"); // 0xABCD

    // Navigate back from the load (shouldn't affect memory)
    ctx.previous().check_reg("x3", "0x00000000");

    // Navigate back from the store (should restore memory)
    ctx.previous();

    // Try to load again - should get 0 since memory was restored
    ctx.exec("LW x4, 0(x1)").check_reg("x4", "0x00000000");
}

#[test]
fn test_previous_csr_operations() {
    let mut ctx = TestContext::new();

    // Write to MSCRATCH CSR
    ctx.exec("ADDI x1, x0, 1234").exec("CSRRW x2, 0x340, x1"); // Write to mscratch

    // Read it back to verify
    ctx.exec("CSRRS x3, 0x340, x0") // Read mscratch
        .check_reg("x3", "0x000004d2");

    // Navigate back from the read
    ctx.previous().check_reg("x3", "0x00000000");

    // Navigate back from the write
    ctx.previous();

    // Read again - should get original value (0)
    ctx.exec("CSRRS x4, 0x340, x0")
        .check_reg("x4", "0x00000000");
}

#[test]
fn test_previous_limit() {
    let mut ctx = TestContext::new();

    // Execute many instructions
    for i in 1..10 {
        ctx.exec(&format!("ADDI x{}, x0, {}", i, i * 10));
    }

    // Try to undo all - should eventually fail
    let mut undo_count = 0;
    while ctx.inner.previous_state().is_ok() {
        undo_count += 1;
    }

    // Should have undone at least some instructions
    assert!(undo_count > 0);

    // Further undo should fail
    ctx.previous_should_fail();
}

#[test]
fn test_next_cleared_after_new_instruction() {
    let mut ctx = TestContext::new();

    // Execute some instructions
    ctx.exec("ADDI x1, x0, 10").exec("ADDI x2, x0, 20");

    // Undo one
    ctx.previous().check_reg("x2", "0x00000000");

    // Execute a new instruction
    ctx.exec("ADDI x3, x0, 30");

    // Redo should now fail
    ctx.next_should_fail();
}

#[test]
fn test_pseudo_instruction_undo() {
    let mut ctx = TestContext::new();

    // Execute pseudo-instructions
    ctx.exec("LI x1, 0x12345").exec("MV x2, x1");

    // Verify state
    ctx.check_reg("x2", "0x00012345"); // 0x12345

    // Undo MV
    ctx.previous_expect("MV").check_reg("x2", "0x00000000");

    // x1 should still have the value
    ctx.check_reg("x1", "0x00012345");
}

#[test]
fn test_branch_instruction_undo() {
    let mut ctx = TestContext::new();

    // Set up for branch
    ctx.exec("ADDI x1, x0, 5").exec("ADDI x2, x0, 5");

    // Get current PC
    let pc_before = ctx.get_pc();

    // Execute branch
    ctx.exec("BEQ x1, x2, 8");

    // PC should have advanced
    let pc_after = ctx.get_pc();
    assert_ne!(pc_before, pc_after);

    // Navigate back from the branch
    ctx.previous();

    // PC should be restored
    let pc_restored = ctx.get_pc();
    assert_eq!(pc_before, pc_restored);
}

#[test]
fn test_invalid_instruction_not_in_history() {
    let mut ctx = TestContext::new();

    // Execute valid instruction
    ctx.exec("ADDI x1, x0, 10");

    // Try invalid instruction
    let err = ctx.exec_fail("INVALID x1, x2, x3");
    assert!(err.contains("Invalid token") || err.contains("Unknown"));

    // Undo should undo the ADDI, not fail on the invalid instruction
    ctx.previous_expect("ADDI").check_reg("x1", "0x00000000");

    // Another undo should fail (no more history)
    ctx.previous_should_fail();
}

// --- go_to: jump to any point in history ----------------------------------

mod go_to {
    use brubeck::interpreter::Interpreter;
    use brubeck::rv32_i::Register;
    use brubeck::HistoryError;

    /// x1 = 1, x1 = 2, x2 = 5, then a store of x2 to address 16.
    fn four_steps() -> Interpreter {
        let mut i = Interpreter::with_config(1024, 100);
        for line in [
            "ADDI x1, x0, 1",
            "ADDI x1, x0, 2",
            "ADDI x2, x0, 5",
            "SW x2, 16(x0)",
        ] {
            i.interpret(line).unwrap();
        }
        i
    }

    #[test]
    fn going_back_returns_the_net_change() {
        let mut i = four_steps();
        let delta = i.go_to(0).unwrap();

        assert_eq!(i.history_position(), 0);
        assert_eq!(i.history_len(), 4);
        assert_eq!(i.cpu.get_register(Register::X1), 0);
        assert_eq!(i.cpu.get_register(Register::X2), 0);
        assert_eq!(i.cpu.pc, 0);
        assert_eq!(&i.cpu.memory[16..20], &[0, 0, 0, 0]);

        // One entry per register, from where we were to where we are.
        assert_eq!(
            delta.register_changes,
            vec![(Register::X2, 5, 0), (Register::X1, 2, 0)]
        );
        assert_eq!(delta.pc_change, (16, 0));
        let bytes: usize = delta.memory_changes.iter().map(|m| m.new_data.len()).sum();
        assert_eq!(bytes, 1, "only the low byte of 5 was non-zero");
    }

    #[test]
    fn going_forward_replays_to_the_target() {
        let mut i = four_steps();
        i.go_to(0).unwrap();
        let delta = i.go_to(2).unwrap();

        assert_eq!(i.history_position(), 2);
        assert_eq!(i.cpu.get_register(Register::X1), 2);
        assert_eq!(i.cpu.get_register(Register::X2), 0);
        assert_eq!(i.cpu.pc, 8);
        // x1 went 0 -> 1 -> 2; the net change is 0 -> 2.
        assert_eq!(delta.register_changes, vec![(Register::X1, 0, 2)]);
        assert_eq!(delta.pc_change, (0, 8));
    }

    #[test]
    fn matches_stepping_one_at_a_time() {
        let mut jumped = four_steps();
        let mut stepped = four_steps();
        jumped.go_to(1).unwrap();
        for _ in 0..3 {
            stepped.previous_state().unwrap();
        }
        assert_eq!(jumped.cpu.pc, stepped.cpu.pc);
        assert_eq!(jumped.cpu.memory, stepped.cpu.memory);
        for n in 0..32 {
            let r = Register::from_u32(n);
            assert_eq!(jumped.cpu.get_register(r), stepped.cpu.get_register(r));
        }
    }

    #[test]
    fn going_to_the_current_position_changes_nothing() {
        let mut i = four_steps();
        let delta = i.go_to(4).unwrap();
        assert!(delta.register_changes.is_empty());
        assert!(delta.memory_changes.is_empty());
        assert_eq!(delta.pc_change, (16, 16));
        assert_eq!(i.history_position(), 4);
    }

    #[test]
    fn going_past_the_end_is_an_error_and_changes_nothing() {
        let mut i = four_steps();
        i.go_to(1).unwrap();
        assert!(matches!(i.go_to(5), Err(HistoryError::AtEnd)));
        assert_eq!(i.history_position(), 1);
        assert_eq!(i.cpu.get_register(Register::X1), 1);
    }

    #[test]
    fn new_instruction_after_going_back_discards_the_steps_ahead() {
        let mut i = four_steps();
        i.go_to(1).unwrap();
        i.interpret("ADDI x3, x0, 3").unwrap();
        assert_eq!(i.history_len(), 2);
        assert_eq!(i.history_position(), 2);
        assert!(matches!(i.go_to(3), Err(HistoryError::AtEnd)));
    }
}
