function stripPrefixPath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/dev/null") return null;
  if (trimmed.startsWith("a/") || trimmed.startsWith("b/")) return trimmed.slice(2);
  return trimmed;
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

export function normalizeArtifactPath(value: string): string | null {
  const normalized = normalizeSlashes(String(value ?? "").trim());
  if (!normalized) return null;
  if (normalized.startsWith("/")) return null;

  const parts = normalized
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  if (parts.some((part) => part === "." || part === "..")) return null;
  return parts.join("/");
}

export function splitPatchIntoFileSections(patchText: string): string[] {
  const text = patchText.replace(/\r\n/g, "\n").trimEnd();
  if (!text.trim()) return [];

  const lines = text.split("\n");
  const sections: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (line.startsWith("diff --git ") && current.length > 0) {
      sections.push(current.join("\n"));
      current = [line];
      continue;
    }
    current.push(line);
  }

  if (current.length > 0) sections.push(current.join("\n"));
  return sections;
}

export function parsePatchPaths(section: string): { oldPath: string | null; newPath: string | null } {
  const lines = section.replace(/\r\n/g, "\n").split("\n");
  let oldPath: string | null = null;
  let newPath: string | null = null;

  const diffGit = lines.find((line) => line.startsWith("diff --git "));
  if (diffGit) {
    const match = diffGit.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (match) {
      oldPath = match[1] ?? null;
      newPath = match[2] ?? null;
    }
  }

  const fromLine = lines.find((line) => line.startsWith("--- "));
  const toLine = lines.find((line) => line.startsWith("+++ "));
  if (fromLine) oldPath = stripPrefixPath(fromLine.slice(4));
  if (toLine) newPath = stripPrefixPath(toLine.slice(4));

  return {
    oldPath: oldPath ? normalizeArtifactPath(oldPath) : null,
    newPath: newPath ? normalizeArtifactPath(newPath) : null,
  };
}

export function inferPatchStatus(section: string): "A" | "D" | "R" | "B" | "M" {
  if (/^new file mode /m.test(section)) return "A";
  if (/^deleted file mode /m.test(section)) return "D";
  if (/^rename from /m.test(section) || /^rename to /m.test(section)) return "R";
  if (/^Binary files /m.test(section) || /^GIT binary patch$/m.test(section)) return "B";
  return "M";
}

function hasReviewableBody(section: string): boolean {
  if (/^@@ /m.test(section)) return true;
  if (/^Binary files /m.test(section) || /^GIT binary patch$/m.test(section)) return true;
  if (/^pi-diff-review: diff omitted /m.test(section)) return true;
  if (/^pi-diff-review: binary diff omitted /m.test(section)) return true;
  return false;
}

export function observedChangedPathFromPatchSection(section: string): string | null {
  const status = inferPatchStatus(section);
  if (status === "A" && !hasReviewableBody(section) && !/^new file mode /m.test(section)) return null;
  const { oldPath, newPath } = parsePatchPaths(section);
  return newPath ?? oldPath;
}

export function observedChangedPathsFromPatch(patchText: string): string[] {
  const seen = new Set<string>();
  const observed: string[] = [];
  for (const section of splitPatchIntoFileSections(patchText)) {
    const observedPath = observedChangedPathFromPatchSection(section);
    if (!observedPath || seen.has(observedPath)) continue;
    seen.add(observedPath);
    observed.push(observedPath);
  }
  return observed;
}

