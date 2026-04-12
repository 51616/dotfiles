# Command context for tools

This extension patches plain extension contexts so tools and event handlers can call session-control actions without faking interactive TUI input.

## Responsibilities

It exposes `reload`, `newSession`, `switchSession`, `fork`, `navigateTree`, and idle-wait hooks on the plain extension context when the underlying runner already has those handlers.

Its main job is to make tool-driven session control reliable for extensions such as [[pi-slash]].

## Invariants

The patch should be idempotent and must not wrap `ExtensionRunner.createContext` more than once.

It should only copy through capabilities that already exist on the runner instead of inventing fallback behavior.

## Failure and recovery

If a handler is unavailable on the runner, the context should simply omit that capability rather than pretending it exists.

This patch must stay narrow: if upstream context creation changes, prefer a clean failure over silently attaching the wrong methods.

## Change guidance

If you change exposed actions or context patching behavior, inspect [[pi-slash]] because that extension depends on these hooks for reliable command execution outside the TUI input layer.

Changes here also need a `/reload` so running sessions see the patched context shape.

## Verification

Run `bash lat-local.sh .pi/extensions check` after editing this lattice.
