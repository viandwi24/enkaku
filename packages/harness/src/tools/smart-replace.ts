// §14.A — smart matching: a SMALL cascade (exact -> line-trimmed -> ws-normalized).
// Precision over recall: fail -> let the model retry rather than risk wrong-location edits.

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function smartReplace(content: string, oldStr: string, newStr: string): string | null {
  const occ = content.split(oldStr).length - 1;
  if (occ === 1) return content.replace(oldStr, newStr);
  if (occ > 1) return null; // ambiguous -> refuse

  const lt = matchLineTrimmed(content, oldStr);
  if (lt) return content.slice(0, lt.start) + newStr + content.slice(lt.end);

  const wn = matchWhitespaceNormalized(content, oldStr);
  if (wn) return content.slice(0, wn.start) + newStr + content.slice(wn.end);

  return null;
}

function matchLineTrimmed(content: string, oldStr: string): { start: number; end: number } | null {
  const cLines = content.split("\n");
  let oLines = oldStr.split("\n");
  if (oLines.length > 1 && oLines[oLines.length - 1] === "") oLines = oLines.slice(0, -1);
  if (oLines.length === 0) return null;

  const offsets: number[] = [];
  let acc = 0;
  for (const l of cLines) {
    offsets.push(acc);
    acc += l.length + 1;
  }
  for (let i = 0; i + oLines.length <= cLines.length; i++) {
    let ok = true;
    for (let j = 0; j < oLines.length; j++) {
      if ((cLines[i + j] ?? "").trim() !== (oLines[j] ?? "").trim()) {
        ok = false;
        break;
      }
    }
    if (ok) {
      const start = offsets[i] ?? 0;
      const lastIdx = i + oLines.length - 1;
      const end = (offsets[lastIdx] ?? 0) + (cLines[lastIdx] ?? "").length;
      return { start, end };
    }
  }
  return null;
}

function matchWhitespaceNormalized(content: string, oldStr: string): { start: number; end: number } | null {
  const pattern = escapeRegex(oldStr).replace(/\s+/g, "\\s+");
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch {
    return null;
  }
  const m = re.exec(content);
  if (!m) return null;
  return { start: m.index, end: m.index + m[0].length };
}
