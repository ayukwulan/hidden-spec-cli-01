// mend: one command-line tool that applies AI-written edits in four formats
// (unified diffs, SEARCH/REPLACE blocks, V4A patches, JSON tool-call edits)
// to a tree of text files, exactly as SPEC.md in this kit's starter says.
// Written from scratch in this session. Node 22+, standard library only.
// Run as: node main.ts [--format=NAME] [--check] [--strict] [PATCH]

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** Thrown to answer exit 2 with one line. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One failed edit: reported as `error: <code> <path>` on exit 1. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';
const rtrimWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with /, holds no \, and none of its
 *  /-separated segments is empty, . or ... */
function safe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's line break is CRLF when its first line feed follows a carriage return, LF otherwise. */
function fileBreak(text: string): string {
  const i = text.indexOf('\n');
  return i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
}

interface SplitFile {
  lines: string[];
  br: string;
  final: boolean;
}

/** Split a file's text into its lines, its line break and whether it ends with one. */
function splitFile(text: string): SplitFile {
  if (text === '') return { lines: [], br: '\n', final: false };
  const br = fileBreak(text);
  const final = text.endsWith(br);
  const parts = text.split(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

/** Join lines back with the file's own break and final break (an empty file stays empty). */
function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

/** Compare two paths in UTF-8 byte order, for the output listing. */
function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p) as string | null;
  }
  get(p: string): string | null {
    return this.now.has(p) ? (this.now.get(p) as string | null) : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** One line of an old block O or a new block N. `ctx` lines are in both; `oIdx` is the line's
 *  index inside O, so a context line of N is written as the file's own matched line. */
interface OLine {
  text: string;
  ctx: boolean;
  oIdx: number;
}

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rtrimWs(a) === rtrimWs(b);
  return trimWs(a) === trimWs(b);
}

/** Every 0-based position at or after `from` where O matches the file's lines at this tier. */
function occurrences(lines: string[], old: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = from; i + old.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < old.length; j++) {
      if (!lineEq(lines[i + j] as string, old[j] as string, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which O occurs at least once. */
function findTier(
  lines: string[],
  old: string[],
  strict: boolean,
  from: number,
  keep?: (pos: number) => boolean,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, old, t, from).filter((p) => (keep === undefined ? true : keep(p)));
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/** Replace the k matched lines at `pos` with N. Context lines of N are written as the file's
 *  own matched lines. At tier 2 every other line of N is re-indented from O's first line's
 *  leading whitespace to the file's first matched line's. */
function applyOldNew(lines: string[], o: OLine[], n: OLine[], pos: number, tier: number): string[] {
  const out = lines.slice(0, pos);
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = leadWs(lines[pos] as string);
    p = leadWs(o[0]!.text);
  }
  for (const nl of n) {
    if (nl.ctx) {
      out.push(lines[pos + nl.oIdx] as string);
      continue;
    }
    let t = nl.text;
    if (tier === 2 && t !== '' && !/^[ \t]*$/.test(t) && t.startsWith(p)) t = f + t.slice(p.length);
    out.push(t);
  }
  out.push(...lines.slice(pos + o.length));
  return out;
}

/** Split a hunk/chunk body into its old lines O and new lines N. */
function bodyToON(body: BodyLine[]): { o: OLine[]; n: OLine[] } {
  const o: OLine[] = [];
  const n: OLine[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      const idx = o.length;
      o.push({ text: b.text, ctx: true, oIdx: idx });
      n.push({ text: b.text, ctx: true, oIdx: idx });
    } else if (b.kind === 'old') {
      o.push({ text: b.text, ctx: false, oIdx: -1 });
    } else if (b.kind === 'new') {
      n.push({ text: b.text, ctx: false, oIdx: -1 });
    }
  }
  return { o, n };
}

/** One parsed body line of a unified hunk or a V4A chunk. `bs` is a `\` line, which refers to
 *  the body line before it. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
}

/** True when a `\` line follows the body's last line of one of the given kinds. */
function noEolAfterLast(body: BodyLine[], kinds: Array<'ctx' | 'new'>): boolean {
  for (let i = body.length - 1; i >= 0; i--) {
    const k = body[i]!.kind;
    if (k !== 'ctx' && k !== 'new') continue;
    if (!kinds.includes(k)) continue;
    return body[i + 1] !== undefined && body[i + 1]!.kind === 'bs';
  }
  return false;
}

/** Parse one raw body line, or null when it is not a body line at all. */
function parseBodyLine(l: string): BodyLine | null {
  if (l === '') return { kind: 'ctx', text: '' };
  const c = l[0] as string;
  if (c === ' ') return { kind: 'ctx', text: l.slice(1) };
  if (c === '-') return { kind: 'old', text: l.slice(1) };
  if (c === '+') return { kind: 'new', text: l.slice(1) };
  if (c === '\\') return { kind: 'bs', text: l.slice(1) };
  return null;
}

/** Detect the patch's format with --format=auto (SPEC.md section 4), or null when none fits. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) =>
        l.startsWith('diff --git ') ||
        (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when the value is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const crlf = fileBreak(before) === '\r\n';
      const norm = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = norm(before);
      const old = norm(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + norm(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      const lines = [...f.lines];
      lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(lines, f.br, f.final));
    };
  }
  return null;
}

/** Read the patch as JSON edits: one array, or one edit object per line. */
function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    if (edits.length === 0) throw new Exit2('error: parse 1');
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}


/** One unified section: one edit (SPEC.md section 6). A null path is /dev/null; undefined is unnamed. */
interface USection {
  oldPath: string | null | undefined;
  newPath: string | null | undefined;
  isCreate: boolean;
  isDelete: boolean;
  hunks: UHunk[];
}

/** One hunk: its old start line A (1-based) and its body as raw patch lines. */
interface UHunk {
  a: number;
  raw: string[];
}

/** The path of a `--- ` / `+++ ` header line: text after the four characters, up to the first
 *  tab, with surrounding spaces removed; /dev/null means no file; a leading a/ or b/ is removed. */
function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** Parse a `diff --git a/<X> b/<Y>` line, or null when it is not of that form. */
function parseDiffGit(line: string): { a: string; b: string } | null {
  const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line.trimEnd());
  return m === null ? null : { a: m[1] as string, b: m[2] as string };
}

/** Parse a hunk header `@@ -A[,B] +C[,D] @@` (optionally followed by text): A, or null. */
function parseHunkHeader(line: string): number | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  return m === null ? null : parseInt(m[1] as string, 10);
}

/** Read the patch as unified diffs: its sections, in order. */
function parseUnified(lines: string[]): USection[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let curHunk: UHunk | null = null;
  let mode: 'outside' | 'header' | 'between' | 'inhunk' = 'outside';
  const startSection = (a: string | null, b: string | null): void => {
    cur = { oldPath: a, newPath: b, isCreate: false, isDelete: false, hunks: [] };
    sections.push(cur);
    curHunk = null;
    mode = 'header';
  };
  const endBody = (): void => {
    if (curHunk !== null) {
      while (curHunk.raw.length > 0 && curHunk.raw[curHunk.raw.length - 1] === '') curHunk.raw.pop();
      curHunk = null;
    }
    mode = 'between';
  };
  const sectionStartAt = (i: number): boolean =>
    lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
  let i = 0;
  while (i < lines.length) {
    const l = lines[i] as string;
    if (mode === 'outside') {
      if (l.startsWith('diff --git ')) {
        const g = parseDiffGit(l);
        if (g === null) throw new Exit2(`error: parse ${i + 1}`);
        startSection(g.a, g.b);
        i++;
      } else if (l.startsWith('--- ') && sectionStartAt(i)) {
        startSection(null, null);
      } else if (l.startsWith('@@')) {
        throw new Exit2(`error: parse ${i + 1}`);
      } else {
        i++;
      }
      continue;
    }
    if (mode === 'header') {
      if (l.startsWith('@@')) {
        const a = parseHunkHeader(l);
        if (a === null) throw new Exit2(`error: parse ${i + 1}`);
        curHunk = { a, raw: [] };
        cur!.hunks.push(curHunk);
        mode = 'inhunk';
        i++;
      } else if (l.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          cur!.oldPath = headerPath(l);
          cur!.newPath = headerPath(lines[i + 1] as string);
          i += 2;
        } else {
          throw new Exit2(`error: parse ${i + 2}`);
        }
      } else if (l.startsWith('rename from ')) {
        cur!.oldPath = l.slice('rename from '.length).trim();
        i++;
      } else if (l.startsWith('rename to ')) {
        cur!.newPath = l.slice('rename to '.length).trim();
        i++;
      } else if (l === 'new file mode' || l.startsWith('new file mode ')) {
        cur!.isCreate = true;
        i++;
      } else if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) {
        cur!.isDelete = true;
        i++;
      } else if (l.startsWith('diff --git ')) {
        const g = parseDiffGit(l);
        if (g === null) throw new Exit2(`error: parse ${i + 1}`);
        startSection(g.a, g.b);
        i++;
      } else {
        i++;
      }
      continue;
    }
    if (mode === 'between') {
      if (l.startsWith('@@')) {
        const a = parseHunkHeader(l);
        if (a === null) throw new Exit2(`error: parse ${i + 1}`);
        curHunk = { a, raw: [] };
        cur!.hunks.push(curHunk);
        mode = 'inhunk';
        i++;
      } else if (l.startsWith('diff --git ')) {
        const g = parseDiffGit(l);
        if (g === null) throw new Exit2(`error: parse ${i + 1}`);
        startSection(g.a, g.b);
        i++;
      } else if (l.startsWith('--- ') && sectionStartAt(i)) {
        startSection(null, null);
      } else {
        i++;
      }
      continue;
    }
    // mode === 'inhunk': the body ends at a diff --git line, at a --- line followed by a +++
    // line, at a hunk header, or at the first line that is not a body line.
    if (l.startsWith('--- ') && sectionStartAt(i)) {
      endBody();
      startSection(null, null);
    } else if (l.startsWith('diff --git ')) {
      endBody();
      const g = parseDiffGit(l);
      if (g === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(g.a, g.b);
      i++;
    } else if (l.startsWith('@@')) {
      endBody();
      const a = parseHunkHeader(l);
      if (a === null) throw new Exit2(`error: parse ${i + 1}`);
      curHunk = { a, raw: [] };
      cur!.hunks.push(curHunk);
      mode = 'inhunk';
      i++;
    } else if (parseBodyLine(l) !== null) {
      curHunk!.raw.push(l);
      i++;
    } else {
      endBody();
    }
  }
  if (mode === 'inhunk') endBody();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections;
}

/** Turn a unified section into its one edit. `recordMove` notes a successful move for the
 *  output listing. */
function unifiedEdit(
  s: USection,
  strict: boolean,
  recordMove: (oldP: string, newP: string) => void,
): Edit {
  return (tree) => {
    const oldP = s.oldPath !== undefined ? s.oldPath : s.newPath;
    const newP = s.newPath !== undefined ? s.newPath : s.oldPath;
    const isCreate = oldP === null || s.isCreate;
    const isDelete = !isCreate && (newP === null || s.isDelete);
    if (oldP !== null && oldP !== undefined && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && newP !== undefined && !safe(newP)) throw new Fail('unsafe', newP);
    if (isCreate) {
      if (newP === null || newP === undefined) return;
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let noEol = false;
      for (const h of s.hunks) {
        const body = h.raw.map((l) => parseBodyLine(l) as BodyLine);
        for (const b of body) if (b.kind === 'new') plus.push(b.text);
        if (body.some((b) => b.kind === 'new')) noEol = noEolAfterLast(body, ['new']);
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (oldP === null || oldP === undefined) return;
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP === null || oldP === undefined || newP === null || newP === undefined) return;
    const isMove = oldP !== newP;
    if (tree.get(oldP) === null) throw new Fail('missing', oldP);
    if (isMove && tree.get(newP) !== null) throw new Fail('exists', newP);
    const before = tree.get(oldP) as string;
    let f = splitFile(before);
    let lines = f.lines;
    let final = f.final;
    let d = 0;
    for (const h of s.hunks) {
      const body = h.raw.map((l) => parseBodyLine(l) as BodyLine);
      const { o, n } = bodyToON(body);
      if (o.length === 0) {
        const at = Math.min(Math.max(h.a + d, 0), lines.length);
        const atEnd = at === lines.length;
        lines = [...lines.slice(0, at), ...n.map((x) => x.text), ...lines.slice(at)];
        if (atEnd) final = !noEolAfterLast(body, ['ctx', 'new']);
        d += n.length;
        continue;
      }
      const found = findTier(lines, o.map((x) => x.text), strict, 0);
      if (found === null) throw new Fail('no-match', oldP);
      const target = h.a - 1 + d;
      let best = found.positions[0] as number;
      let bestDist = Math.abs(best - target);
      for (const p of found.positions) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const atEnd = best + o.length === lines.length;
      lines = applyOldNew(lines, o, n, best, found.tier);
      if (atEnd) final = !noEolAfterLast(body, ['ctx', 'new']);
      d += n.length - o.length;
    }
    const text = joinFile(lines, f.br, final);
    if (isMove) {
      tree.now.set(newP, text);
      tree.now.set(oldP, null);
      recordMove(oldP, newP);
    } else {
      tree.now.set(oldP, text);
    }
  };
}


/** Read the patch as SEARCH/REPLACE blocks (SPEC.md section 7): their edits, in order. */
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    let rep = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const old = lines.slice(searchIdx + 1, eq);
    const nw = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, old, nw, strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/** One SEARCH/REPLACE block as its edit. */
function srEdit(path: string, old: string[], nw: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (old.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, nw.length === 0 ? '' : nw.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const f = splitFile(cur);
    const found = findTier(f.lines, old, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0] as number;
    const o: OLine[] = old.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
    const n: OLine[] = nw.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
    tree.now.set(path, joinFile(applyOldNew(f.lines, o, n, pos, found.tier), f.br, f.final));
  };
}


/** One V4A section (SPEC.md section 8). */
interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: VChunk[];
  updateLine: number;
}

/** One V4A chunk: its anchor (null: none), whether *** End of File closed it, and its body. */
interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

const V_ADD = '*** Add File: ';
const V_DEL = '*** Delete File: ';
const V_UPD = '*** Update File: ';
const V_MOVE = '*** Move to: ';

/** Read the patch as a V4A patch: its sections, in order. */
function parseV4a(lines: string[]): VSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  const last = lines.reduce((acc, l, idx) => (!blank(l) ? idx : acc), -1);
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i] as string;
    if (blank(l)) {
      i++;
      continue;
    }
    let kind: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (l.startsWith(V_ADD)) {
      kind = 'add';
      path = l.slice(V_ADD.length).trim();
    } else if (l.startsWith(V_DEL)) {
      kind = 'delete';
      path = l.slice(V_DEL.length).trim();
    } else if (l.startsWith(V_UPD)) {
      kind = 'update';
      path = l.slice(V_UPD.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const startLine = i + 1;
    i++;
    // Collect the section's raw lines, then drop the blank lines at its end.
    const raw: Array<{ text: string; num: number }> = [];
    while (i < last) {
      const t = lines[i] as string;
      if (t.startsWith(V_ADD) || t.startsWith(V_DEL) || t.startsWith(V_UPD)) break;
      raw.push({ text: t, num: i + 1 });
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      const addLines: string[] = [];
      for (const r of raw) {
        if (r.text === '') addLines.push('');
        else if (r.text.startsWith('+')) addLines.push(r.text.slice(1));
        else throw new Exit2(`error: parse ${r.num}`);
      }
      sections.push({ kind, path, moveTo: null, addLines, chunks: [], updateLine: startLine });
    } else if (kind === 'delete') {
      for (const r of raw) {
        if (!blank(r.text)) throw new Exit2(`error: parse ${r.num}`);
      }
      sections.push({ kind, path, moveTo: null, addLines: [], chunks: [], updateLine: startLine });
    } else {
      let moveTo: string | null = null;
      let j = 0;
      if (raw.length > 0 && raw[0]!.text.startsWith(V_MOVE)) {
        moveTo = raw[0]!.text.slice(V_MOVE.length).trim();
        j = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let firstChunk = true;
      for (; j < raw.length; j++) {
        const r = raw[j] as { text: string; num: number };
        const t = r.text;
        if (t.startsWith('@@')) {
          const anchor = t.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          chunks.push(cur);
          firstChunk = false;
        } else if (t.trimEnd() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${r.num}`);
          cur.eof = true;
          cur = null;
        } else {
          const b = parseBodyLine(t);
          if (b === null) throw new Exit2(`error: parse ${r.num}`);
          if (cur === null) {
            if (!firstChunk) throw new Exit2(`error: parse ${r.num}`);
            cur = { anchor: null, eof: false, body: [] };
            chunks.push(cur);
            firstChunk = false;
          }
          cur.body.push(b);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startLine}`);
      sections.push({ kind, path, moveTo, addLines: [], chunks, updateLine: startLine });
    }
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections;
}

/** The first line at or after `from` equal to the anchor at the first tier where one is, or -1. */
function findAnchorLine(lines: string[], anchor: string, strict: boolean, from: number): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (lineEq(lines[i] as string, anchor, t)) return i;
    }
  }
  return -1;
}

/** Turn a V4A section into its one edit. */
function v4aEdit(
  s: VSection,
  strict: boolean,
  recordMove: (oldP: string, newP: string) => void,
): Edit {
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, s.addLines.length === 0 ? '' : s.addLines.join('\n') + '\n');
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const cur = tree.get(s.path);
    if (cur === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const f = splitFile(cur);
    let lines = f.lines;
    let cursor = 0;
    for (const chunk of s.chunks) {
      const { o, n } = bodyToON(chunk.body);
      if (chunk.anchor !== null) {
        const ai = findAnchorLine(lines, chunk.anchor, strict, cursor);
        if (ai < 0) throw new Fail('no-match', s.path);
        cursor = ai + 1;
      }
      if (o.length === 0) {
        const at = chunk.eof ? lines.length : cursor;
        lines = [...lines.slice(0, at), ...n.map((x) => x.text), ...lines.slice(at)];
        cursor = at + n.length;
      } else {
        const keep = chunk.eof ? (p: number): boolean => p + o.length === lines.length : undefined;
        const found = findTier(lines, o.map((x) => x.text), strict, cursor, keep);
        if (found === null) throw new Fail('no-match', s.path);
        const pos = found.positions[0] as number;
        lines = applyOldNew(lines, o, n, pos, found.tier);
        cursor = pos + n.length;
      }
    }
    const text = joinFile(lines, f.br, f.final);
    if (s.moveTo !== null) {
      tree.now.set(s.moveTo, text);
      tree.now.set(s.path, null);
      recordMove(s.path, s.moveTo);
    } else {
      tree.now.set(s.path, text);
    }
  };
}


/** Run the CLI on its arguments; return its exit code and its stdout lines. */
function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) {
        format = a.slice(9);
      } else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: Array<[string, string]> = [];
  const recordMove = (oldP: string, newP: string): void => {
    moves.push([oldP, newP]);
  };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') {
      edits = parseUnified(lines).map((s) => unifiedEdit(s, strict, recordMove));
    } else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines).map((s) => v4aEdit(s, strict, recordMove));
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [
        ...fails.map((f) => `error: ${f.code} ${f.path}`),
        `failed: ${fails.length} of ${edits.length} edits`,
      ],
    };
  }
  // One output line per path whose state changed, in UTF-8 byte order of the paths. A
  // successful move prints `R <old> -> <new>` instead of that pair's D and A lines, and
  // sorts by <new>.
  const rows: Array<{ key: string; text: string }> = [];
  const covered = new Set<string>();
  for (const [oldP, newP] of moves) {
    if (
      tree.original(oldP) !== null &&
      tree.get(oldP) === null &&
      tree.original(newP) === null &&
      tree.get(newP) !== null
    ) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p) as string | null;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteCompare(a.key, b.key));
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteCompare)) {
      const now = tree.now.get(p) as string | null;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return {
    code: 0,
    out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`],
  };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one,
  // without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
