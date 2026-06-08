// @lat: [[extensions#Working spinner customization]]

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { buildOpencodeScannerIndicator } from "../lib/shared/opencode-scanner.ts";

const WORKING_MESSAGES: readonly string[] = [
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
];

type UiContext = Pick<ExtensionContext, "hasUI" | "ui">;

const INVISIBLE_WORKING_MESSAGE = "\u200B";

let lastWorkingMessage: string | null = null;

function chooseWorkingMessage(): string {
  const candidates = WORKING_MESSAGES.filter((message) => message !== lastWorkingMessage);
  const next = candidates[Math.floor(Math.random() * candidates.length)] ?? WORKING_MESSAGES[0] ?? "Working";
  lastWorkingMessage = next;
  return next;
}

function applySpinner(ctx: UiContext): void {
  if (!ctx.hasUI) return;
  const workingMessage = chooseWorkingMessage();

  // pi's Loader always renders indicator frames before the working message and
  // treats an empty message as a request to restore the default. Put the label
  // in each verbatim indicator frame, then keep the built-in message invisible.
  ctx.ui.setWorkingMessage(INVISIBLE_WORKING_MESSAGE);
  ctx.ui.setWorkingIndicator(buildOpencodeScannerIndicator(ctx.ui.theme, workingMessage));
}

export default function customSpinner(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    applySpinner(ctx);
  });

  pi.on("before_agent_start", (_event, ctx) => {
    applySpinner(ctx);
  });
}
