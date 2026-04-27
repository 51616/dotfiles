# Track Spec: <track_description>

> This spec is the elaborate, self-contained behavior contract for the track.
>
> Write it so a future agent can understand and implement the work without chat history or current-session context. Avoid phrases like “as discussed”, “the current request”, “this session”, or “the previous plan”; replace them with durable facts, repo-relative paths, explicit decisions, and stable references.
>
> Test policy: do not write tests for the sake of testing. Every new/changed test must directly prove one of the expected behaviors or scenario examples defined here.

## Context
(What’s the situation / background? Include stable project facts, affected areas, relevant file paths, existing behavior, and the reason this track exists. Do not rely on chat history.)

## Goal
(What concrete outcome do we want? Describe user-visible/system-visible behavior and success state.)

## Non-goals
(What are we explicitly *not* doing in this track? Name nearby tempting work that should stay out of scope.)

## Requirements
(Use precise, testable requirements. Include inputs/outputs, data contracts, CLI/API/UI behavior, persistence rules, observability expectations, and compatibility constraints where relevant.)
- 

## Acceptance criteria
(Each item should be objectively checkable and traceable to expected behaviors or scenarios.)
- 

## Expected behaviors
(Describe what the system should do under meaningful conditions. Cover the happy path, important failures, notable edge cases, and any intentionally unchanged behavior.)
- 

## Scenario examples
(Plain-language examples that make the behaviors concrete. Add the happy path, key validation failures, important edge cases, and ambiguity checks where needed. Include concrete inputs, steps, and expected outcomes.)
- 

## Evidence plan (scenario → proof)
(For each scenario you care about, state how you’ll prove it. Prefer tests when feasible. Do not add tests that don’t prove an approved scenario.)

If the repo uses `lat.md/`, prefer writing the test-spec in `lat.md/` (see the `lat-md` skill) and linking tests to it via `@lat:` comments.

- Scenario:
  - Proof:

## Constraints / assumptions
(List explicit assumptions, environmental constraints, dependency constraints, migration constraints, and known limits. If an assumption came from user preference or project convention, state it as a durable decision rather than a session note.)
- 

## Risks
(What could break? Include correctness, migration, operational, security/privacy, performance, and maintainability risks where relevant.)
- 

## Open questions
(Only include questions that must be resolved before implementation. Do not leave ambiguity hidden in the plan.)
- 
