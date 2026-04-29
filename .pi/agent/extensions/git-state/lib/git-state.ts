export type GitStateSnapshot = {
  branchName: string;
  files: number;
  additions: number;
  deletions: number;
  repoRoot: string;
};

const ANSI_RESET = "\x1b[0m";
const ANSI_DIM = "\x1b[2m";
const ANSI_GREEN = "\x1b[1;32m";
const ANSI_YELLOW = "\x1b[1;33m";
const ANSI_RED = "\x1b[1;31m";
const ANSI_CYAN = "\x1b[1;36m";

function color(text: string, code: string): string {
  return `${code}${text}${ANSI_RESET}`;
}

function formatCount(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.max(0, Math.trunc(value));
  if (rounded < 1_000) return String(rounded);
  if (rounded < 10_000) return `${(rounded / 1_000).toFixed(1)}k`;
  if (rounded < 1_000_000) return `${Math.round(rounded / 1_000)}k`;
  return `${(rounded / 1_000_000).toFixed(1)}M`;
}

export function parsePorcelainFileCount(output: string): number {
  return output
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => line.trim().length > 0).length;
}

export function parseNumstat(output: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;

  for (const line of output.replace(/\r\n/g, "\n").split("\n")) {
    if (!line.trim()) continue;
    const [rawAdded, rawDeleted] = line.split("\t");
    const added = Number.parseInt(rawAdded ?? "", 10);
    const deleted = Number.parseInt(rawDeleted ?? "", 10);
    if (Number.isFinite(added)) additions += added;
    if (Number.isFinite(deleted)) deletions += deleted;
  }

  return { additions, deletions };
}

export function buildGitStateSignature(snapshot: GitStateSnapshot | null): string {
  if (!snapshot) return "none";
  return `${snapshot.repoRoot}\t${snapshot.branchName}\t${snapshot.files}\t${snapshot.additions}\t${snapshot.deletions}`;
}

export function formatGitStateLabel(snapshot: GitStateSnapshot): string {
  const filesColor = snapshot.files === 0 ? ANSI_GREEN : ANSI_CYAN;
  const additionsColor = snapshot.additions === 0 ? ANSI_GREEN : ANSI_GREEN;
  const deletionsColor = snapshot.deletions === 0 ? ANSI_GREEN : ANSI_RED;

  const branchLabel = snapshot.branchName.trim() || "unknown";

  const branchText = ` ${branchLabel}`;

  if (snapshot.files === 0 && snapshot.additions === 0 && snapshot.deletions === 0) {
    return [branchText, color("CLEAN!", ANSI_GREEN)].join(" ");
  }

  return [
    branchText,
    `${color(formatCount(snapshot.files), filesColor)}${color("", ANSI_DIM)}`,
    `${color("+", ANSI_DIM)}${color(formatCount(snapshot.additions), additionsColor)}`,
    `${color("-", ANSI_DIM)}${color(formatCount(snapshot.deletions), deletionsColor)}`,
  ].join(" ");
}
