import { escapeHtml } from "./html.ts";

// Colors the audit view only. The Terraform file text is unchanged.
export function highlightJson(source: string): string {
  let index = 0;
  let html = "";
  while (index < source.length) {
    const char = source[index] ?? "";
    if (char === " " || char === "\n" || char === "\r" || char === "\t") {
      const start = index;
      index += 1;
      while (index < source.length && isSpace(source[index] ?? "")) index += 1;
      html += source.slice(start, index);
      continue;
    }
    if (char === '"') {
      const end = readString(source, index);
      const token = source.slice(index, end);
      index = end;
      html += paintString(token, isKey(source, index));
      continue;
    }
    if (char === "-" || isDigit(char)) {
      const end = readNumber(source, index);
      html += `<span class="tok-num">${escapeHtml(source.slice(index, end))}</span>`;
      index = end;
      continue;
    }
    const word = literalAt(source, index);
    if (word) {
      html += `<span class="tok-lit">${word}</span>`;
      index += word.length;
      continue;
    }
    if ("{}[]:,".includes(char)) {
      html += `<span class="tok-pun">${char}</span>`;
      index += 1;
      continue;
    }
    html += escapeHtml(char);
    index += 1;
  }
  return html;
}

function paintString(token: string, key: boolean): string {
  if (key) return `<span class="tok-key">${escapeHtml(token)}</span>`;
  const open = token[0] ?? "";
  const closed = token.length > 1 && token.endsWith('"');
  const inner = token.slice(1, closed ? -1 : undefined);
  let html = `<span class="tok-str">${escapeHtml(open)}`;
  let index = 0;
  while (index < inner.length) {
    const ref = referenceAt(inner, index);
    if (ref > index) {
      html += `</span><span class="tok-ref">${escapeHtml(inner.slice(index, ref))}</span><span class="tok-str">`;
      index = ref;
      continue;
    }
    const next = nextReference(inner, index + 1);
    html += escapeHtml(inner.slice(index, next));
    index = next;
  }
  if (closed) html += escapeHtml('"');
  return `${html}</span>`;
}

function referenceAt(text: string, index: number): number {
  if (text[index] !== "$" || text[index + 1] !== "{" || text[index - 1] === "\\") return index;
  let end = index + 2;
  while (end < text.length && text[end] !== "}") end += 1;
  return end < text.length ? end + 1 : end;
}

function nextReference(text: string, from: number): number {
  for (let index = from; index < text.length; index += 1) {
    if (referenceAt(text, index) > index) return index;
  }
  return text.length;
}

function isKey(source: string, index: number): boolean {
  let cursor = index;
  while (cursor < source.length && isSpace(source[cursor] ?? "")) cursor += 1;
  return source[cursor] === ":";
}

function readString(source: string, start: number): number {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source[index] === '"') return index + 1;
    index += 1;
  }
  return source.length;
}

function readNumber(source: string, start: number): number {
  let index = start;
  if (source[index] === "-") index += 1;
  if (source[index] === "0") index += 1;
  else while (isDigit(source[index] ?? "")) index += 1;
  if (source[index] === "." && isDigit(source[index + 1] ?? "")) {
    index += 2;
    while (isDigit(source[index] ?? "")) index += 1;
  }
  if (source[index] === "e" || source[index] === "E") {
    const mark = index + 1;
    let cursor = mark;
    if (source[cursor] === "+" || source[cursor] === "-") cursor += 1;
    if (isDigit(source[cursor] ?? "")) {
      index = cursor + 1;
      while (isDigit(source[index] ?? "")) index += 1;
    }
  }
  return index === start ? start + 1 : index;
}

function literalAt(source: string, index: number): "true" | "false" | "null" | "" {
  for (const word of ["true", "false", "null"] as const) {
    if (!source.startsWith(word, index)) continue;
    const next = source[index + word.length] ?? "";
    if (next && /[A-Za-z0-9_]/.test(next)) continue;
    return word;
  }
  return "";
}

function isSpace(char: string): boolean {
  return char === " " || char === "\n" || char === "\r" || char === "\t";
}

function isDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}
