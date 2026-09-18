/** Refuse malformed UTF-16 rather than silently encoding replacement characters. */
export function assertUnicodeScalars(text: string): void {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error("Invalid Unicode scalar value.");
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error("Invalid Unicode scalar value.");
  }
}

/** Validate grammar with JSON.parse, then reject duplicate decoded keys and invalid strings.
 * The scan never rewrites the input. Hashes must still use the original UTF-8 bytes.
 */
export function parseRecoveryJson(text: string): any {
  assertUnicodeScalars(text);
  const parsed: unknown = JSON.parse(text);
  let position = 0;
  const whitespace = () => { while (/[\x20\x09\x0a\x0d]/.test(text[position] ?? "x")) position++; };
  const string = (): string => {
    const start = position++;
    while (text[position] !== '"') {
      if (text[position] === "\\") position += 2;
      else position++;
    }
    const value = JSON.parse(text.slice(start, ++position)) as string;
    assertUnicodeScalars(value);
    return value;
  };
  const value = (depth: number): void => {
    if (depth > 128) throw new Error("Recovery JSON nesting exceeds its limit.");
    whitespace();
    const token = text[position];
    if (token === '"') { string(); return; }
    if (token === "{") {
      position++; whitespace(); const keys = new Set<string>();
      if (text[position] === "}") { position++; return; }
      for (;;) {
        whitespace(); const key = string();
        if (keys.has(key)) throw new Error("Duplicate recovery JSON key.");
        keys.add(key); whitespace(); position++; // colon, already syntax-validated
        value(depth + 1); whitespace();
        if (text[position++] === "}") return;
      }
    }
    if (token === "[") {
      position++; whitespace();
      if (text[position] === "]") { position++; return; }
      for (;;) { value(depth + 1); whitespace(); if (text[position++] === "]") return; }
    }
    while (position < text.length && !/[\x20\x09\x0a\x0d,\]}]/.test(text[position]!)) position++;
  };
  value(0);
  return parsed;
}
