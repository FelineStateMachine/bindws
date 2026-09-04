// JSONC as wrangler reads it: // and /* */ comments outside strings, and
// trailing commas, removed so JSON.parse takes the rest.
import { readFileSync } from "node:fs";

export function stripComments(text) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i];
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) throw new Error("unterminated comment");
      i = end + 1;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export const readJSONC = (path) => JSON.parse(stripComments(readFileSync(path, "utf8")));
