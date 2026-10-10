export type ParsedPatchFile = {
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly raw: string;
};

function decodeQuotedPath(token: string): string {
  if (!token.startsWith('"') || !token.endsWith('"')) throw new Error("Patch diff header path quote is malformed");
  const body = token.slice(1, -1);
  let output = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!;
    if (char !== "\\") { output += char; continue; }
    index += 1;
    if (index >= body.length) throw new Error("Patch diff header path escape is malformed");
    const escaped = body[index]!;
    if (escaped === "\\" || escaped === '"') output += escaped;
    else if (escaped === "t") output += "\t";
    else if (escaped === "n") output += "\n";
    else if (escaped === "r") output += "\r";
    else if (/[0-7]/.test(escaped)) {
      let octal = escaped;
      for (let count = 0; count < 2 && index + 1 < body.length && /[0-7]/.test(body[index + 1]!); count += 1) {
        index += 1;
        octal += body[index]!;
      }
      output += String.fromCharCode(Number.parseInt(octal, 8));
    } else throw new Error("Patch diff header path escape is unsupported");
  }
  return output;
}

function readHeaderToken(text: string, start: number): { readonly value: string; readonly next: number } {
  let index = start;
  while (index < text.length && /\s/.test(text[index]!)) index += 1;
  if (index >= text.length) throw new Error("Patch diff header path is missing");
  if (text[index] === '"') {
    const tokenStart = index;
    index += 1;
    let escaped = false;
    for (; index < text.length; index += 1) {
      const char = text[index]!;
      if (escaped) { escaped = false; continue; }
      if (char === "\\") { escaped = true; continue; }
      if (char === '"') return { value: decodeQuotedPath(text.slice(tokenStart, index + 1)), next: index + 1 };
    }
    throw new Error("Patch diff header quoted path is malformed");
  }
  const tokenStart = index;
  while (index < text.length && !/\s/.test(text[index]!)) index += 1;
  return { value: text.slice(tokenStart, index), next: index };
}

function parseHeaderTokens(value: string): readonly [string, string] {
  const text = value.trim();
  if (!text) throw new Error("Patch diff header is empty");
  const first = readHeaderToken(text, 0);
  const second = readHeaderToken(text, first.next);
  if (text.slice(second.next).trim().length > 0) throw new Error("Patch diff header contains unparsed path content");
  return [first.value, second.value];
}

function parseFileMarker(value: string): string | null {
  const text = value.trim();
  if (!text) throw new Error("Patch file marker path is missing");
  if (text.startsWith('"')) {
    const token = readHeaderToken(text, 0);
    if (text.slice(token.next).trim().length > 0) throw new Error("Patch file marker contains unparsed path content");
    return normalizePatchPath(token.value);
  }
  const tab = text.indexOf("\t");
  const raw = tab >= 0 ? text.slice(0, tab) : text;
  if (/\s/.test(raw)) throw new Error("Patch file marker path with spaces must be quoted");
  return normalizePatchPath(raw);
}

export function normalizePatchPath(raw: string): string | null {
  if (raw === "/dev/null") return null;
  const path = raw.replace(/^[ab]\//, "");
  if (!path || raw === path || path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.includes("\\") || path.includes("\0")) throw new Error(`Patch path escapes repository root: ${raw}`);
  const segments = path.split("/");
  if (segments.some((part) => !part || part === "." || part === "..")) throw new Error(`Patch path escapes repository root: ${raw}`);
  return path;
}

export function parsePatchFiles(patch: string): readonly ParsedPatchFile[] {
  const matches = [...patch.matchAll(/^diff --git (.*)$/gm)];
  if (matches.length === 0) throw new Error("Patch contains no diff --git headers");
  const literalHeaderCount = patch.split("\n").filter((line) => line.startsWith("diff --git ")).length;
  if (literalHeaderCount !== matches.length) throw new Error("Patch diff header count could not be parsed");

  const files: ParsedPatchFile[] = [];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    const start = match.index!;
    const end = index + 1 < matches.length ? matches[index + 1]!.index! : patch.length;
    const raw = patch.slice(start, end);
    const [leftRaw, rightRaw] = parseHeaderTokens(match[1]!);
    const oldPath = normalizePatchPath(leftRaw);
    const newPath = normalizePatchPath(rightRaw);
    if (oldPath === null && newPath === null) throw new Error("Patch file cannot have /dev/null on both sides");

    const oldMarkerMatch = raw.match(/^--- (.*)$/m);
    const newMarkerMatch = raw.match(/^\+\+\+ (.*)$/m);
    if (Boolean(oldMarkerMatch) !== Boolean(newMarkerMatch)) throw new Error("Patch old/new file markers are incomplete");
    if (oldMarkerMatch && newMarkerMatch) {
      const markerOld = parseFileMarker(oldMarkerMatch[1]!);
      const markerNew = parseFileMarker(newMarkerMatch[1]!);
      if (markerOld !== null && markerOld !== oldPath) throw new Error("Patch old file marker does not match diff header");
      if (markerNew !== null && markerNew !== newPath) throw new Error("Patch new file marker does not match diff header");
    }
    files.push({ oldPath, newPath, raw });
  }
  return files;
}

export function isTestPath(path: string): boolean {
  return /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\.[^/]+$/i.test(path);
}

export function testOnlyPatch(patch: string): string | null {
  const files = parsePatchFiles(patch).filter((file) => [file.oldPath, file.newPath].some((path) => path !== null && isTestPath(path)));
  return files.length > 0 ? files.map((file) => file.raw).join("") : null;
}

export function testPathsFromPatch(patch: string): readonly string[] {
  const paths = new Set<string>();
  for (const file of parsePatchFiles(patch)) for (const path of [file.oldPath, file.newPath]) if (path && isTestPath(path)) paths.add(path);
  return [...paths];
}
