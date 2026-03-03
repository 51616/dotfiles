# Scrutiny round contract example

For a 10-round loop, each round must produce exactly:

- `rounds/round_<NN>/review_round_<NN>.md`
- `rounds/round_<NN>/trim_round_<NN>.md`
- `rounds/round_<NN>/implement_round_<NN>.md`

And after each round:

- update `rounds/progress.md`
- update track `plan.md`
- update track `resume.md`
- run declared verification commands and record PASS/FAIL text in `implement_round_<NN>.md`

Default scope mode policy used in this vault:

- Round 01–02: `legacy_partial`
- Round 03+: full-domain only (`extensions_full`, `scripts_full`, `both_full`)
