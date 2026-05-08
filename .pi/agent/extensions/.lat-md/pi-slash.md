# Pi slash

This extension is the canonical programmatic slash-command path for session control, model switching, guarded commands such as `/reload`, `/new`, `/resume`, and `/compact`, and the tool-oriented `/tree` flow.

## Responsibilities

It normalizes slash names and aliases, exposes the `pi_slash` tool surface, and routes built-in session controls through direct APIs instead of pretending to type commands into the TUI.

For `/tree`, it provides a tool-safe variant: `slash.run "/tree"` returns a textual tree snapshot, while `slash.run "/tree <entryId> [--summary]"` jumps directly without opening the interactive tree picker.

It also owns confirmation behavior for risky commands and the scheduling rule for `/reload` when the current turn is still running.

## Invariants

Risky commands require confirmation unless the caller passes force explicitly.

Built-in slash commands should execute through one canonical direct control path so tool-driven and command-driven behavior stay aligned.

If `/reload` is requested mid-turn, it should be scheduled after the response finishes rather than interrupting an in-flight turn.

If `/tree <entryId>` is requested mid-turn, it should also be scheduled after the response finishes so session navigation does not interrupt the active tool call.

Headless or no-UI contexts should fail cleanly when confirmation is required and force was not supplied.

## Failure and recovery

Invalid slash syntax should fail with a clear error instead of trying to guess user intent.

Model-setting flows should validate provider/model identifiers against the registry before claiming success.

If a risky command cannot be confirmed in the current context, the extension should reject it explicitly so callers can retry with force or a safer workflow.

If `/tree` is invoked without an entry id from the tool path, return the textual tree instead of trying to open the interactive selector that only makes sense for a human operator.

## Change guidance

If you change aliases, confirmation policy, or session-control routing, keep the `pi_slash` tool and interactive slash behavior aligned.

For `/tree`, keep the distinction explicit: interactive `/tree` still owns the picker UI, while `pi_slash` owns the direct-id programmatic path and the text snapshot.

Changes to tool-side session actions may also require checking `command-context-for-tools`, because that extension exposes the reload/new/resume/session hooks used outside the TUI input layer.

The most direct regression coverage is `.pi/extensions/test/pi-slash-aliases.test.mjs`.

## Verification

Run `bash lat-local.sh .pi/extensions check` after editing this lattice.

Run `node --test .pi/extensions/test/pi-slash-aliases.test.mjs` to verify aliases and confirmation semantics.
