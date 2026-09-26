// Minimal, dependency-free scanning of Terraform source that has been
// formatted with `terraform fmt`. It is not a full HCL parser: it only extracts
// the few constructs the CI checks need (backend blocks, module sources,
// provider blocks, region literals).

/** Removes `#`, `//` and `/* *\/` comments while keeping string literals intact. */
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (inString) {
      out += c;
      if (c === "\\" && next !== undefined) {
        out += next;
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === "#" || (c === "/" && next === "/")) {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Returns the bodies of every block whose header matches `header` (a regex source). */
export function findBlocks(src: string, header: string): string[] {
  const code = stripComments(src);
  const re = new RegExp(`${header}\\s*\\{`, "g");
  const bodies: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    let inString = false;
    const start = i;
    while (i < code.length && depth > 0) {
      const c = code[i]!;
      if (inString) {
        if (c === "\\") i++;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
      i++;
    }
    bodies.push(code.slice(start, i - 1));
  }
  return bodies;
}

/** Reads top-level `name = <literal>` attributes of a block body. Nested blocks are ignored. */
export function attributes(body: string): Record<string, string | boolean | number> {
  const attrs: Record<string, string | boolean | number> = {};
  let depth = 0;
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (depth === 0) {
      const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.+)$/.exec(trimmed);
      if (m) {
        const raw = m[2]!.trim();
        if (/^".*"$/.test(raw)) attrs[m[1]!] = raw.slice(1, -1);
        else if (raw === "true" || raw === "false") attrs[m[1]!] = raw === "true";
        else if (/^-?\d+$/.test(raw)) attrs[m[1]!] = Number(raw);
        else attrs[m[1]!] = raw;
      }
    }
    for (const c of trimmed) {
      if (c === "{") depth++;
      else if (c === "}") depth--;
    }
  }
  return attrs;
}

export interface BackendBlock {
  type: string;
  attrs: Record<string, string | boolean | number>;
}

export function backendBlocks(src: string): BackendBlock[] {
  const result: BackendBlock[] = [];
  for (const tf of findBlocks(src, "(?:^|\\n)\\s*terraform")) {
    const re = /backend\s+"([^"]+)"\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(tf)) !== null) {
      const body = findBlocks(tf.slice(m.index), `backend\\s+"${m[1]}"`)[0] ?? "";
      result.push({ type: m[1]!, attrs: attributes(body) });
    }
  }
  return result;
}

/** Local module sources (`source = "../..."`) of every module block. */
export function moduleSources(src: string): string[] {
  return findBlocks(src, 'module\\s+"[^"]+"')
    .map((body) => attributes(body)["source"])
    .filter((s): s is string => typeof s === "string");
}

export interface ProviderBlock {
  name: string;
  attrs: Record<string, string | boolean | number>;
}

export function providerBlocks(src: string): ProviderBlock[] {
  const code = stripComments(src);
  const re = /provider\s+"([^"]+)"\s*\{/g;
  const result: ProviderBlock[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const body = findBlocks(code.slice(m.index), `provider\\s+"${m[1]}"`)[0] ?? "";
    result.push({ name: m[1]!, attrs: attributes(body) });
  }
  return result;
}

/** AWS region names referenced anywhere in code (comments excluded). */
export function regionLiterals(src: string): string[] {
  const found = stripComments(src).match(/\b(?:af|ap|ca|eu|il|me|mx|sa|us|cn)(?:-gov)?-[a-z]+-\d\b/g);
  return [...new Set(found ?? [])].sort();
}
