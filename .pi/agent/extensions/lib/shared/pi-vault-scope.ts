import path from "node:path";

export type VaultScopeOptions = {
  envRoot?: string;
  isVaultRoot: (dir: string) => boolean;
};

export function isPathInsideRoot(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function resolveScopedVaultRoot(cwd: string, { envRoot, isVaultRoot }: VaultScopeOptions): string {
  const root = String(envRoot || "").trim();
  if (root && isVaultRoot(root) && isPathInsideRoot(root, cwd)) {
    return root;
  }

  let cur = path.resolve(cwd);
  while (true) {
    if (isVaultRoot(cur)) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  return "";
}

export function shouldEnableWithinVaultScope(cwd: string, options: VaultScopeOptions): boolean {
  try {
    return Boolean(resolveScopedVaultRoot(cwd, options));
  } catch {
    return false;
  }
}
