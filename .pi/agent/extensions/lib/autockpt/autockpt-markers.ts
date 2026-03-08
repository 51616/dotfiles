// NOTE: These markers are intentionally weird and stable. Extensions depend on exact matching.

// Context-stamp prefix used by .pi/extensions/context-stamp.
// Self-checkpointing relies on this prefix to avoid false-positive matches when tool output happens
// to contain CHECKPOINT_NOW_MARKER (e.g. printing source code that defines the constant).
export const CONTEXT_STAMP_MARKER = "[pi ctx]";

export const CHECKPOINT_NOW_MARKER = "__PI_CHECKPOINT_NOW__";
export const COMPACTION_INSTR_BEGIN = "__pi_compact_instructions_begin__";
export const COMPACTION_INSTR_END = "__pi_compact_instructions_end__";
export const AUTOCHECKPOINT_DONE_MARKER = "__pi_autocheckpoint_done__";
