# ast-grep tool for pi

This **global** pi extension registers a custom tool named `ast-grep` that wraps the **ast-grep** CLI (https://github.com/ast-grep/ast-grep).

## Install

This extension vendors the CLI via npm:

```bash
cd ~/.pi/agent/extensions/ast-grep
npm install

# (In this vault, ~/.pi/agent/extensions is a symlink to ./agents/extensions)
```

Notes:
- The ast-grep project also provides a binary named `sg`, but on many Linux systems `sg` already exists (different program). This extension always calls `ast-grep` to avoid that conflict.

## Tool

- Tool name: `ast-grep`
- Search: provide `pattern` (and optionally `lang`, `paths`)
- Rewrite preview (diff): provide `pattern` + `rewrite`
- Apply rewrite: set `apply=true` (will modify files; no confirmation)

Examples (what pi may call under the hood):

```bash
ast-grep run -p 'foo()' -l ts .
ast-grep run -p 'foo()' -l ts -r 'bar()' .
ast-grep run -p 'foo()' -l ts -r 'bar()' --update-all .
```
