export interface PathValidationResult {
  valid: boolean;
  reason?: string;
}

function normalizePosix(p: string): string {
  const parts = p.split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      resolved.pop();
    } else if (part !== ".") {
      resolved.push(part);
    }
  }
  return resolved.join("/") || "/";
}

export function validatePath(
  inputPath: string,
  opts: { allowlist?: string[]; denylist?: string[] } = {}
): PathValidationResult {
  if (!inputPath.startsWith("/")) {
    return { valid: false, reason: "path must be absolute (POSIX)" };
  }
  if (inputPath.includes("\0")) {
    return { valid: false, reason: "null byte in path" };
  }
  if (inputPath.includes("..")) {
    return { valid: false, reason: "path traversal detected (..)" };
  }

  const resolved = normalizePosix(inputPath);
  const { allowlist, denylist } = opts;

  if (denylist) {
    for (const denied of denylist) {
      if (resolved === denied || resolved.startsWith(denied + "/")) {
        return { valid: false, reason: `path is under denied prefix: ${denied}` };
      }
    }
  }

  if (allowlist && allowlist.length > 0) {
    const permitted = allowlist.some(
      (allowed) => resolved === allowed || resolved.startsWith(allowed + "/")
    );
    if (!permitted) {
      return { valid: false, reason: "path is not under any allowed prefix" };
    }
  }

  return { valid: true };
}
