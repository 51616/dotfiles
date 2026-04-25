# custom-spinner

Customizes pi's interactive working spinner label and animation.

Current behavior: randomly chooses one label per session start and agent turn, without immediately repeating the previous label. The label appears before the scanner. The animation copies opencode's prompt scanner: an 8-cell block trail that moves left-to-right, holds at the end, moves right-to-left, then holds at the start.

This extension uses `ctx.ui.setWorkingMessage()` and `ctx.ui.setWorkingIndicator()` on `session_start` and `before_agent_start`. pi's built-in `Loader` renders indicator frames before the working message, so the extension embeds the muted label inside each verbatim indicator frame and sets the built-in message to a zero-width placeholder. `setWorkingIndicator()` only affects the normal streaming working indicator; compaction and retry loaders keep their built-in styling. The frames render the label bold, keep the scanner glyphs italic, and use pi theme palette colors: `borderAccent` for the current theme's cyan head/trail with dim intensity for the far trail, and `muted` for the label and visible inactive cells.

## Active label options

Good labels should stay readable in a tight terminal footer. This pool intentionally mixes plain, technical, cozy, and whimsical labels so repeated turns feel less stale.

The active pool is exactly:

```ts
[
  "Cooking",
  "Thinking",
  "Working",
  "Brewing",
  "Crunching",
  "Weaving",
  "Forging",
  "Simmering",
  "Booping",
  "Channelling",
  "Computing",
  "Concocting",
  "Contemplating",
  "Crafting",
  "Cultivating",
  "Deliberating",
  "Discombobulating",
  "Doodling",
  "Embellishing",
  "Enchanting",
  "Generating",
  "Harmonizing",
  "Hatching",
  "Improvising",
  "Incubating",
  "Infusing",
  "Ionizing",
  "Kneading",
  "Levitating",
  "Manifesting",
  "Marinating",
  "Meandering",
  "Noodling",
  "Orchestrating",
  "Pollinating",
  "Pondering",
  "Pontificating",
  "Pouncing",
  "Processing",
  "Propagating",
  "Puzzling",
  "Seasoning",
  "Shenaniganing",
  "Smooshing",
  "Spinning",
  "Sprouting",
  "Sublimating",
  "Swirling",
  "Swooping",
  "Symbioting",
  "Synthesizing",
  "Tinkering",
  "Transfiguring",
  "Transmuting",
  "Twisting",
  "Undulating",
  "Vibing",
  "Wandering",
  "Whirring",
  "Wrangling",
]
```

## Source note

The wave-like opencode spinner lives in `packages/opencode/src/cli/cmd/tui/ui/spinner.ts` and is used by `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`. The upstream prompt uses `createFrames({ style: "blocks", inactiveFactor: 0.6, minAlpha: 0.3 })`, `createColors(...)`, width `8`, bidirectional movement, hold-start `30`, hold-end `9`, and interval `40`ms. This extension intentionally uses `50`ms to make the movement slightly slower while keeping the wave responsive.
