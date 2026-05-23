# Example: root router lattice with nested lattices

Use this pattern when a repo has one top-level map plus subtrees that own their own code-linked detail.

## Shape

- `.lat-md/` at repo root for cross-cutting maps and root-level anchors
- nested lattices like `subproject/.lat-md/` for subtree-owned architecture and contracts
- inside each `.lat-md/`, keep the canonical root content in `index.md`
- normal markdown links from the root lattice into the nested lattice docs

## Why

The root lattice answers where to start and who owns what.

The nested lattice answers what must stay true when that subtree changes.

This avoids duplicating sections just to pretend all lattices are one merged graph.

## Verification

Run checks for every lattice that was touched:

```bash
bash .pi/skills/lat-md/scripts/check-all-lattices.sh <repo-root>
```

Or explicitly:

```bash
bash .pi/skills/lat-md/scripts/run-lat.sh <repo-root> check --no-color
bash .pi/skills/lat-md/scripts/run-lat.sh <nested-owner-root> check --no-color
```

## Good root-level content

- top-level system map
- ownership boundaries across subtrees
- root-level entrypoints that have `@lat:` anchors
- links to the nested lattices

## Good nested-lattice content

- subtree responsibilities
- invariants and contracts
- failure/recovery behavior
- test specs tied to real tests with `@lat:` comments
