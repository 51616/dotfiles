# Command palette

Owns the slash-command overlay opened with `ctrl+shift+p` and the `/palette` command, with `ctrl+alt+p` as a fallback for terminals that collapse Ctrl+Shift+letter into Ctrl+letter.

The overlay mirrors the interactive slash-command catalog. It fuzzy-filters built-in interactive commands plus prompt, extension, and skill commands. `Shift+Enter` still inserts the selected `/<name> ` back into the main editor.

## Prompt-template instant insertion

Prompt-template commands resolve immediately on `Enter`. The extension reads the selected prompt-template file, strips frontmatter, and pastes the expanded body at the current editor cursor.

If the body uses `$1` or `$@` placeholders, the palette asks for arguments first. When the captured cursor line is non-empty, the pasted prompt gets two leading blank lines so reusable directives land as their own block.

Because pi reserves `ctrl+shift+p` for backward model cycling by default, this extension depends on `~/.pi/agent/keybindings.json` remapping `app.model.cycleBackward` to `ctrl+alt+[`.

Entrypoint: [[command-palette/index.ts]].
