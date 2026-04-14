# Google TypeScript Style Guide Summary

This document summarizes key rules and best practices from the Google TypeScript Style Guide (commonly enforced by `gts`).

## 1. Language Features
- Always use `const` or `let`. **`var` is forbidden.** Use `const` by default.
- Use ES6 modules (`import`/`export`). **Do not use `namespace`.**
- Prefer named exports. Avoid default exports.
- Prefer `readonly` for constructor-only assignment.
- Use `===` / `!==`.
- Avoid type assertions (`x as T`) and non-null assertions (`y!`) unless clearly justified.

## 2. Disallowed / discouraged
- Avoid `any` (prefer `unknown` or a specific type).
- Don’t rely on ASI; use explicit semicolons.
- Don’t use `eval()` / `Function(...string)`.

## 3. Naming
- `UpperCamelCase` for classes/interfaces/types/enums.
- `lowerCamelCase` for variables/functions/methods/properties.

## 4. Types
- Prefer optional fields/params (`?`) over `| undefined`.
- Prefer `T[]` for simple arrays.
- Don’t use `{}` as a type.

*Source: https://google.github.io/styleguide/tsguide.html*
