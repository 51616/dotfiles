# Default code-search behavior
You are operating in an environment where `ast-grep` is installed. `ast-grep` uses Abstract Syntax Tree (AST) patterns to match code based on its structure rather than just text, enabling powerful and precise code search across large codebases.

When searching **source code**, default to the `ast-grep` tool (syntax-aware) rather than `rg`/`grep`/`find`. Use `rg`/`grep`/`find` mainly for **plain text** (Markdown/docs/logs/config) or when you explicitly need substring/regex search.

Inside pi, prefer the `ast-grep` tool (this wraps the ast-grep CLI) instead of invoking the binary via `bash`.

Rule of thumb:
- Default to `ast-grep` for code search.
- Use `rg`/`grep`/`find` only for plain-text searches (docs/logs/config) or when you explicitly *don’t* want syntax awareness.

Workflow:
- Search-only: provide `pattern` (omit `rewrite` and `apply`).
- Rewrite preview: set `rewrite` (keep `apply=false`) to see diffs.
- Apply: set `apply=true` only after the preview looks correct.
