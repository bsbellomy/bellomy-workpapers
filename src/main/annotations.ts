// Annotation sidecars: [root]\[Client]\Private\[subfolder__filename].json
//
// Tickmarks, sign-offs, tape stamps, highlights, notes and "added by" provenance
// for a workpaper are stored in a JSON file beside the client's other firm-only
// material, keyed by the document's path under the client folder with the
// separators flattened to "__".
//
// The root is normally the TaxDome drive (T:), so everything written here syncs
// up into the client's TaxDome "Private" folder. Private is firm-only -- clients
// never see it -- and that sync is what makes annotations follow a workpaper
// from one office machine to another.
//
// It also means every sidecar becomes a real TaxDome document. So a sidecar is
// written only when there is something to record:
//
//   * Opening a PDF must NOT create one. It used to: loadAnnotations() wrote a
//     99-byte {tickmarks:[],signoffs:[]} placeholder on first open, which synced
//     up as a document of its own. Viewing a client's intake in order therefore
//     created one junk document per file -- 28 of them for MAGO6841 alone, found
//     2026-10-05 -- all named like the flattened path, which reads at a glance
//     like pipeline metadata dumped into the client's own folder.
//   * Saving empty annotations deletes the sidecar instead of leaving a
//     placeholder behind.
//
// Keep that invariant. `scripts/annotations.test.mjs` enforces it.

import fs from "node:fs";
import path from "node:path";

export interface Annotations {
  tickmarks: unknown[];
  signoffs: unknown[];
  tapeStamps?: unknown[];
  highlights?: unknown[];
  textNotes?: unknown[];
  addedAt?: string;
  addedBy?: string | null;
}

/** The client's firm-only folder. Pure: does not touch the disk. */
export function privateDir(root: string, filePath: string): string {
  const rel = path.relative(root, filePath);
  const clientName = rel.split(path.sep)[0];
  return path.join(root, clientName, "Private");
}

/** The sidecar path for a document. Pure: does not touch the disk. */
export function annFile(root: string, filePath: string): string {
  const rel = path.relative(root, filePath);
  const parts = rel.split(path.sep);
  const subPath = parts.slice(1).join("__");
  return path.join(privateDir(root, filePath), subPath + ".json");
}

/** Called only on the write paths, so computing a path never creates a folder. */
export function ensurePrivateDir(root: string, filePath: string): void {
  const dir = privateDir(root, filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * True when a payload carries nothing a sidecar needs to persist.
 *
 * addedAt on its own does not count: it is re-derived from the document's
 * birthtime whenever the sidecar is missing, so storing it alone buys nothing
 * and costs a TaxDome document. addedBy does count -- it is the only record of
 * who scanned a file in.
 */
export function isEmptyAnnotations(a: unknown): boolean {
  if (!a || typeof a !== "object") return true;
  const o = a as Record<string, unknown>;
  for (const k of ["tickmarks", "signoffs", "tapeStamps", "highlights", "textNotes"]) {
    const v = o[k];
    if (Array.isArray(v) && v.length > 0) return false;
  }
  if (o.addedBy !== undefined && o.addedBy !== null && o.addedBy !== "") return false;
  return true;
}

/**
 * Writes JSON over a path, truncating to exactly the bytes written.
 *
 * Plain writeFileSync is not enough on the TaxDome drive: the Dokan mount does
 * not reliably honour the truncate that mode "w" implies, so overwriting a
 * sidecar with a SHORTER payload left the tail of the previous version behind.
 * The result is a file like `...}` + `Crain"\n}` -- invalid JSON, which
 * loadAnnotations() then failed to parse, silently showing the document as
 * having no annotations at all. Found 2026-10-05, affecting sidecars across the
 * firm. Opening the fd and calling ftruncate to the exact length is explicit and
 * does not depend on rename (fs.rename/copyFile both fail on this mount).
 */
function writeJsonExact(f: string, value: unknown): void {
  const json = JSON.stringify(value, null, 2);
  const bytes = Buffer.byteLength(json, "utf8");
  const fd = fs.openSync(f, "w");
  try {
    fs.writeFileSync(fd, json, "utf8");
    fs.ftruncateSync(fd, bytes);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Parses a sidecar, tolerating stale trailing bytes left by the truncation bug
 * above. Takes the first complete top-level object and ignores anything after
 * it, so annotations already corrupted on disk come back instead of reading as
 * empty. The next save rewrites the file cleanly.
 */
function parseSidecar(text: string): Annotations {
  try {
    return JSON.parse(text) as Annotations;
  } catch {
    const start = text.indexOf("{");
    if (start < 0) throw new Error("no object in sidecar");
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (esc) { esc = false; continue; }
      if (inStr) {
        if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return JSON.parse(text.slice(start, i + 1)) as Annotations;
      }
    }
    throw new Error("sidecar object never closes");
  }
}

/** Reads a document's annotations. Never creates a sidecar. */
export function loadAnnotations(root: string, filePath: string): Annotations {
  try {
    const f = annFile(root, filePath);
    if (fs.existsSync(f)) {
      const data = parseSidecar(fs.readFileSync(f, "utf8"));
      if (!data.addedAt) {
        try { data.addedAt = fs.statSync(filePath).birthtime.toISOString(); } catch { /* unreadable */ }
        if (data.addedBy === undefined) data.addedBy = null;
        // The sidecar already exists, so rewriting it adds no new document.
        try { writeJsonExact(f, data); } catch { /* read-only */ }
      }
      return data;
    }
    // No sidecar yet -- hand back a fresh in-memory object. Nothing is written
    // until the document is actually annotated.
    let addedAt: string | undefined;
    try { addedAt = fs.statSync(filePath).birthtime.toISOString(); } catch { /* unreadable */ }
    return { tickmarks: [], signoffs: [], addedAt, addedBy: null };
  } catch {
    return { tickmarks: [], signoffs: [] };
  }
}

/** Writes a document's annotations, or removes the sidecar if there are none. */
export function saveAnnotations(root: string, filePath: string, annotations: unknown): boolean {
  try {
    const f = annFile(root, filePath);
    if (isEmptyAnnotations(annotations)) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* best effort */ }
      return true;
    }
    ensurePrivateDir(root, filePath);
    writeJsonExact(f, annotations);
    return true;
  } catch {
    return false;
  }
}
