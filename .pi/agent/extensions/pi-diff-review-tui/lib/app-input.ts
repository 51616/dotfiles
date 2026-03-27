import { Key, matchesKey } from "@mariozechner/pi-tui";
import type { FocusMode } from "./types.ts";

export type AppInputAction =
  | { type: "none" }
  | { type: "switchPane" }
  | { type: "openHelp" }
  | { type: "togglePerf" }
  | { type: "focusDiff" }
  | { type: "createLineComment" }
  | { type: "quit" }
  | { type: "switchScope"; scope: "t" | "u" | "s" | "a" }
  | { type: "reloadScope" }
  | { type: "openComments" }
  | { type: "peekCommentsAtCursor" }
  | { type: "createRangeComment" }
  | { type: "toggleRangeSelection" }
  | { type: "createFileComment" }
  | { type: "editOverallComment" }
  | { type: "openEditor"; lineTargeted: boolean }
  | { type: "submit" }
  | { type: "toggleHunkRejected" }
  | { type: "jumpComment"; direction: 1 | -1; fileOnly: boolean }
  | { type: "jumpCommentFile"; staleOnly: boolean }
  | { type: "moveFile"; direction: 1 | -1 }
  | { type: "moveDiff"; direction: 1 | -1; steps?: number }
  | { type: "moveChangeBlock"; direction: 1 | -1 };

export function resolveInputAction({
  data,
  focusMode,
  hasFile,
  bodyHeight,
}: {
  data: string;
  focusMode: FocusMode;
  hasFile: boolean;
  bodyHeight: number;
}): AppInputAction {
  if (matchesKey(data, Key.tab)) return { type: "switchPane" };
  if (focusMode === "files" && matchesKey(data, Key.right)) return { type: "switchPane" };
  if (focusMode === "diff" && matchesKey(data, Key.left)) return { type: "switchPane" };
  if (matchesKey(data, "?")) return { type: "openHelp" };
  if (matchesKey(data, "p")) return { type: "togglePerf" };

  if (matchesKey(data, Key.enter)) {
    return focusMode === "files" ? { type: "focusDiff" } : { type: "createLineComment" };
  }

  if (matchesKey(data, "q") || matchesKey(data, Key.escape)) return { type: "quit" };
  if (matchesKey(data, "t")) return { type: "switchScope", scope: "t" };
  if (matchesKey(data, "u")) return { type: "switchScope", scope: "u" };
  if (matchesKey(data, "i")) return { type: "switchScope", scope: "s" };
  if (matchesKey(data, "a")) return { type: "switchScope", scope: "a" };
  if (matchesKey(data, "r")) return { type: "reloadScope" };
  if (matchesKey(data, "m")) return { type: "openComments" };
  if (matchesKey(data, "v")) return { type: "peekCommentsAtCursor" };
  if (matchesKey(data, "c")) return { type: "createLineComment" };
  if (matchesKey(data, "h")) return { type: "createRangeComment" };
  if (matchesKey(data, "x")) return { type: "toggleRangeSelection" };
  if (matchesKey(data, "f")) return { type: "createFileComment" };
  if (matchesKey(data, "o")) return { type: "editOverallComment" };
  if (matchesKey(data, "e")) return { type: "openEditor", lineTargeted: true };
  if (matchesKey(data, "g")) return { type: "openEditor", lineTargeted: false };
  if (matchesKey(data, "s")) return { type: "submit" };
  if (focusMode === "diff" && matchesKey(data, Key.space)) return { type: "toggleHunkRejected" };
  if (matchesKey(data, "n")) return { type: "jumpComment", direction: 1, fileOnly: false };
  if (matchesKey(data, "b")) return { type: "jumpComment", direction: -1, fileOnly: false };
  if (matchesKey(data, ".")) return { type: "jumpComment", direction: 1, fileOnly: true };
  if (matchesKey(data, ",")) return { type: "jumpComment", direction: -1, fileOnly: true };
  if (matchesKey(data, "w")) return { type: "jumpCommentFile", staleOnly: false };
  if (matchesKey(data, "z")) return { type: "jumpCommentFile", staleOnly: true };

  if (!hasFile) return { type: "none" };

  if (focusMode === "files") {
    if (matchesKey(data, "j") || matchesKey(data, Key.down)) return { type: "moveFile", direction: 1 };
    if (matchesKey(data, "k") || matchesKey(data, Key.up)) return { type: "moveFile", direction: -1 };
    return { type: "none" };
  }

  if (matchesKey(data, "j") || matchesKey(data, Key.down)) return { type: "moveDiff", direction: 1 };
  if (matchesKey(data, "k") || matchesKey(data, Key.up)) return { type: "moveDiff", direction: -1 };
  if (matchesKey(data, "]")) return { type: "moveChangeBlock", direction: 1 };
  if (matchesKey(data, "[")) return { type: "moveChangeBlock", direction: -1 };
  if (matchesKey(data, Key.pageDown)) return { type: "moveDiff", direction: 1, steps: bodyHeight };
  if (matchesKey(data, Key.pageUp)) return { type: "moveDiff", direction: -1, steps: bodyHeight };
  return { type: "none" };
}
