# Round {{NN}} Trim — {{scope_label}}

## Round scope declaration
- `scope_mode`: `{{scope_mode}}`

## Candidate decision table

| Candidate | Decision | Rationale |
|---|---|---|
| `CAND-XX` | **remove/defer** | {{rationale_x}} |
| `CAND-YY` | **remove/defer** | {{rationale_y}} |

## Use-trace evidence per candidate

### CAND-XX

#### Static reference trace
- {{static_trace_x}}

#### Import/call-path notes
- {{call_path_x}}

#### Entrypoint/runtime consideration
- {{runtime_x}}

### CAND-YY

#### Static reference trace
- {{static_trace_y}}

#### Import/call-path notes
- {{call_path_y}}

#### Entrypoint/runtime consideration
- {{runtime_y}}

## Risk notes
- {{risk_1}} → mitigation: {{mitigation_1}}

## Actual removals performed
- {{actual_removal_1}}

## Post-trim checks
- `{{verify_cmd_1}}` → {{result_1}}
