# General Code Style Principles

This document defines project-level coding contracts across languages/frameworks.

## Core philosophy

- Prefer boring, explicit code over clever code.
- Optimize for long-term maintainability and debuggability.
- Keep modules cohesive and loosely coupled.

## Structural constraints

- Files should stay lean (target 200–400 LOC; hard warning beyond ~500 LOC).
- Functions should be focused, with clear input/output behavior.
- Extract modules early when scope starts to sprawl.

## Contracts at boundaries

- Use strong typing/schemas where possible (TypeScript, dataclasses/Pydantic, etc.).
- Validate all external input at boundaries (API, CLI, file IO, RPC).
- Prefer explicit domain errors over generic exceptions.

## State and data handling

- Prefer immutable updates over in-place mutation when practical.
- Avoid hidden shared state and cross-module side effects.
- Keep data transformations explicit and easy to trace.

## Error handling and observability

- Fail clearly with actionable error messages.
- Log enough context to diagnose production issues quickly.
- Avoid silent failures and swallowed exceptions.

## Testing expectations

- Default to red → green → refactor workflow for feature work.
- Bug fixes should include regression tests when feasible.
- Prefer tests that verify behavior/contract, not internal implementation details.

## Consistency and docs

- Follow existing naming/layout patterns unless you intentionally migrate them.
- Document *why* decisions were made, not only *what* changed.
- Keep operational docs and runbooks in sync with implementation changes.
