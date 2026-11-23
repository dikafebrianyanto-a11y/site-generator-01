// A faster drop-in for makefun-site 1.0.0: run(input) returns exactly the answer
// makefun-site's build returns, for every case, and nothing else. Written from the
// vendor README and the reference code's stated rules; the pipeline below keeps the
// reference's order and every edge, and earns its speed by doing the same work with
// less waste: Markdown inline text is escaped in whole runs instead of one character
// at a time, slugs are memoised per case with a plain-ASCII fast lane, the lexer
// dispatches on a line's first character before it pays for a regular expression,
// template loops reuse one scope instead of allocating one per item, and the page
// render reuses one scope chain instead of spreading the site record into every call.
//
// No clock, no environment, no randomness, no file: the answer is a function of the
// input alone, and run() keeps no state from one case to the next.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

// ---------------------------------------------------------------- text

/** The HTML escape table, in this order: & < > " ' . */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_TEST = /[&<>"']/;

/**
 * `text` with & < > " and ' escaped. Most runs hold none of the five, so a single
 * test returns the string itself instead of building a copy.
 */
function escapeHtml(text) {
  if (!ESCAPE_TEST.test(text)) return text;
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  return `${+date.slice(8, 10)} ${MONTHS[+date.slice(5, 7) - 1]} ${date.slice(0, 4)}`;
}

/** The words of a body: its runs of characters other than whitespace, counted by a
 * plain character-code scan (the same set JavaScript's \s names, without the cost of
 * a regular expression match per word). */
function countWords(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws =
      c === 32 ||
      (c >= 9 && c <= 13) ||
      c === 0xa0 ||
      c === 0x1680 ||
      (c >= 0x2000 && c <= 0x200a) ||
      c === 0x2028 ||
      c === 0x2029 ||
      c === 0x202f ||
      c === 0x205f ||
      c === 0x3000 ||
      c === 0xfeff;
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

/** The keys a source's front matter may give. */
const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? +m[1] : 0;
      const mo = m ? +m[2] : 0;
      const d = m ? +m[3] : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused.
 * `text` has "\n" line ends. The lines are walked by offset, so the body is one slice
 * of the source instead of a split and a join.
 */
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const first = firstNl === -1 ? text : text.slice(0, firstNl);
  if (first !== '---') return { error: 'no front matter' };
  // First pass: the closing line, before any line is judged (a source with no
  // close is refused as unclosed whatever its lines hold).
  let closeStart = -1;
  let closeEnd = -1;
  let i = firstNl === -1 ? text.length : firstNl + 1; // offset of line index 1
  while (i < text.length) {
    let end = text.indexOf('\n', i);
    if (end === -1) end = text.length;
    if (text.slice(i, end) === '---') {
      closeStart = i;
      closeEnd = end;
      break;
    }
    if (end === text.length) break;
    i = end + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  // Second pass: the lines between the opening and the close, in order.
  const data = {};
  i = firstNl === -1 ? text.length : firstNl + 1;
  let lineIdx = 1;
  while (i < closeStart) {
    const end = text.indexOf('\n', i);
    const line = text.slice(i, end);
    if (!/^[ \t]*$/.test(line) && !line.startsWith('#')) {
      const m = FM_LINE.exec(line);
      if (!m) return { error: `line ${lineIdx + 1} is not "key: value"` };
      const key = m[1];
      const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
      if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    i = end + 1;
    lineIdx++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd === text.length ? '' : text.slice(closeEnd + 1) };
}

// ---------------------------------------------------------------- markdown

const MD_BLANK = /^[ \t]*$/;
const MD_FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const MD_FENCE_CLOSE = /^```[ \t]*$/;
const MD_HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const MD_HR = /^(?:---|\*\*\*)[ \t]*$/;
const MD_BULLET = /^[-*] (.*)$/;
const MD_ORDERED = /^(\d{1,9})\. (.*)$/;
const MD_CONTINUED = /^ {2,}\S/;

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  const m = MD_HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/** A line with spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

/**
 * Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic
 * break. A line's first character already rules most kinds out, so the regular
 * expressions only run where one could match.
 */
function endsParagraph(line) {
  if (line.length === 0) return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return MD_BLANK.test(line);
  if (c === 96) return MD_FENCE_OPEN.test(line);
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return MD_HR.test(line);
  return false;
}

/** `src`'s block tokens, in order. */
function lex(src) {
  const lines = src.split('\n');
  const tokens = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.length === 0) {
      i++;
      continue;
    }
    const c = line.charCodeAt(0);
    if (c === 32 || c === 9) {
      // Only a blank line or a paragraph line can open on a space or tab.
      if (MD_BLANK.test(line)) {
        i++;
        continue;
      }
    } else if (c === 96) {
      const fence = MD_FENCE_OPEN.exec(line);
      if (fence !== null) {
        const body = [];
        i++;
        while (i < lines.length && !MD_FENCE_CLOSE.test(lines[i])) body.push(lines[i++]);
        i++;
        tokens.push({ type: 'code', lang: fence[1], lines: body });
        continue;
      }
    } else if (c === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        tokens.push({ type: 'heading', depth: heading.depth, text: heading.text });
        i++;
        continue;
      }
    } else if (c === 45 || c === 42) {
      if (MD_HR.test(line)) {
        tokens.push({ type: 'hr' });
        i++;
        continue;
      }
      const bullet = MD_BULLET.exec(line);
      if (bullet !== null) {
        const items = [];
        while (i < lines.length) {
          const m = MD_BULLET.exec(lines[i]);
          if (m !== null) {
            items.push([trimLine(m[1])]);
            i++;
          } else if (MD_CONTINUED.test(lines[i])) {
            items[items.length - 1].push(trimLine(lines[i]));
            i++;
          } else break;
        }
        tokens.push({ type: 'list', ordered: false, start: 1, items: items.map((parts) => parts.join('\n')) });
        continue;
      }
    } else if (c >= 48 && c <= 57) {
      const ordered = MD_ORDERED.exec(line);
      if (ordered !== null) {
        const items = [];
        while (i < lines.length) {
          const m = MD_ORDERED.exec(lines[i]);
          if (m !== null) {
            items.push([trimLine(m[2])]);
            i++;
          } else if (MD_CONTINUED.test(lines[i])) {
            items[items.length - 1].push(trimLine(lines[i]));
            i++;
          } else break;
        }
        tokens.push({ type: 'list', ordered: true, start: Number(ordered[1]), items: items.map((parts) => parts.join('\n')) });
        continue;
      }
    } else if (c === 62) {
      const body = [];
      while (i < lines.length && lines[i].charCodeAt(0) === 62) body.push(lines[i++].replace(/^> ?/, ''));
      tokens.push({ type: 'blockquote', lines: body.map(trimLine).filter((l) => l !== '') });
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    tokens.push({ type: 'paragraph', text: body.join('\n') });
  }
  return tokens;
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s` rendered inline; `env.link(target)` is a link's href. The scanner jumps from
 * one markup character to the next and escapes the plain text between them in one
 * call, instead of escaping one character at a time.
 */
function inline(s, env) {
  const re = /[\\`*\[]/g;
  let out = '';
  let i = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const p = m.index;
    const c = s[p];
    if (c === '\\') {
      const n = s[p + 1];
      if (n !== undefined && ESCAPABLE.has(n)) {
        if (p > i) out += escapeHtml(s.slice(i, p));
        out += n === '>' ? '&gt;' : n;
        i = p + 2;
        re.lastIndex = p + 2;
        continue;
      }
      // Not an escape: the backslash is plain text, keep scanning past it.
      re.lastIndex = p + 1;
      continue;
    }
    if (p > i) out += escapeHtml(s.slice(i, p));
    if (c === '`') {
      const j = s.indexOf('`', p + 1);
      if (j > p + 1) {
        out += `<code>${escapeHtml(s.slice(p + 1, j))}</code>`;
        i = j + 1;
      } else {
        out += '`';
        i = p + 1;
      }
    } else if (c === '*') {
      if (s[p + 1] === '*') {
        const j = findUnescaped(s, '**', p + 2);
        if (j > p + 2) {
          out += `<strong>${inline(s.slice(p + 2, j), env)}</strong>`;
          i = j + 2;
        } else {
          out += '**';
          i = p + 2;
        }
      } else {
        const j = findSingleStar(s, p + 1);
        if (j > p + 1) {
          out += `<em>${inline(s.slice(p + 1, j), env)}</em>`;
          i = j + 1;
        } else {
          out += '*';
          i = p + 1;
        }
      }
    } else {
      // '['
      const k = findUnescaped(s, ']', p + 1);
      const mm = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !/\s/.test(target)) {
        out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(p + 1, k), env)}</a>`;
        i = mm + 1;
      } else {
        out += '[';
        i = p + 1;
      }
    }
    re.lastIndex = i;
  }
  if (i < s.length) out += escapeHtml(s.slice(i));
  return out;
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of contents (every level 2
 * and 3 heading: level, id and its inline HTML), its excerpt (the first paragraph's inline HTML, or "") and its word
 * count (counted once here, so a card never counts the body again).
 * `slug` is the case's memoised slugifier.
 */
function renderMarkdown(src, env, slug) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  for (const t of lex(src)) {
    switch (t.type) {
      case 'heading': {
        const id = uniqueSlug(slug(t.text), ids);
        const html = inline(t.text, env);
        blocks.push(`<h${t.depth} id="${id}">${html}</h${t.depth}>`);
        if (t.depth === 2 || t.depth === 3) toc.push({ level: t.depth, id, html });
        break;
      }
      case 'code': {
        const cls = t.lang === '' ? '' : ` class="language-${escapeHtml(t.lang)}"`;
        blocks.push(`<pre><code${cls}>${t.lines.map((l) => `${escapeHtml(l)}\n`).join('')}</code></pre>`);
        break;
      }
      case 'hr':
        blocks.push('<hr>');
        break;
      case 'blockquote':
        blocks.push(t.lines.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(t.lines.join('\n'), env)}</p>\n</blockquote>`);
        break;
      case 'list': {
        const tag = t.ordered ? 'ol' : 'ul';
        const open = t.ordered && t.start !== 1 ? `<ol start="${t.start}">` : `<${tag}>`;
        blocks.push(`${open}\n${t.items.map((item) => `<li>${inline(item, env)}</li>\n`).join('')}</${tag}>`);
        break;
      }
      case 'paragraph': {
        const html = inline(t.text, env);
        if (excerpt === null) excerpt = html;
        blocks.push(`<p>${html}</p>`);
        break;
      }
    }
  }
  return { html: blocks.map((b) => `${b}\n`).join(''), toc, excerpt: excerpt ?? '', words: countWords(src) };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const TPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TPL_IF = /^if (not )?(\S+)$/;
const TPL_INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!TPL_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = TPL_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = TPL_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = TPL_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered in `scope` ({ vars, parent }). `ctx` holds the parsed templates (`templates`, a Map of name to
 * nodes) and the include depth. A for loop reuses one scope object for every item instead of allocating one per item.
 */
function renderNodes(nodes, scope, ctx, depth) {
  let out = '';
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out += n.text;
        break;
      case 'var':
        out += escapeHtml(textOf(lookup(scope, n.path)));
        break;
      case 'raw':
        out += textOf(lookup(scope, n.path));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) out += renderNodes(branch, scope, ctx, depth);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const vars = {};
        const loop = {};
        const child = { vars, parent: scope };
        for (let k = 0; k < xs.length; k++) {
          vars[n.name] = xs[k];
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === xs.length - 1;
          loop.length = xs.length;
          vars.loop = loop;
          out += renderNodes(n.body, child, ctx, depth);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) out += renderNodes(t, scope, ctx, depth + 1);
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- the build

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** One site's output tree: path -> text. */
export function run(input) {
  // Slugs are memoised for this case alone: tag names and headings repeat across
  // a site, and the Unicode normalisation is the dear part. A plain-ASCII text
  // skips the normalisation and the mark strip entirely, which is exact because
  // NFKD is the identity on ASCII and ASCII holds no combining marks.
  const slugCache = new Map();
  const slugify = (text) => {
    const hit = slugCache.get(text);
    if (hit !== undefined) return hit;
    let plain;
    if (/[^\x00-\x7F]/.test(text)) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    else plain = text;
    const out = plain
      .replace(/[A-Z]/g, (c) => c.toLowerCase())
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, SLUG_MAX)
      .replace(/-+$/, '');
    const slug = out === '' ? 'untitled' : out;
    slugCache.set(text, slug);
    return slug;
  };

  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };

  // 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static.
  {
    const files = [...b.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
    for (const f of files) {
      if (f.path.endsWith('.md')) b.sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
      else b.statics.push({ path: f.path, content: f.content });
    }
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  {
    const kept = [];
    for (const s of b.sources) {
      const fm = parseFrontMatter(s.text);
      if ('error' in fm) {
        b.report.push(`refused ${s.path}: ${fm.error}`);
        continue;
      }
      s.data = fm.data;
      s.body = fm.body;
      s.post = s.path.startsWith('posts/');
      let own;
      if (s.path.startsWith('tags/')) own = 'tags';
      else if (s.path.startsWith('page/')) own = 'page';
      if (own !== undefined) {
        b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
        continue;
      }
      if (s.post && !Object.hasOwn(s.data, 'date')) {
        b.report.push(`refused ${s.path}: a post needs a date`);
        continue;
      }
      const layout = s.data.layout ?? (s.post ? 'post' : 'page');
      if (!b.templates.has(layout)) {
        b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
        continue;
      }
      s.layout = layout;
      if (s.data.draft === true) {
        b.report.push(`draft ${s.path}`);
        continue;
      }
      kept.push(s);
    }
    b.sources = kept;
  }

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  {
    const taken = new Map();
    const takenIn = (dir) => {
      if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
      return taken.get(dir);
    };
    for (const s of b.sources) {
      const dir = s.post ? 'posts' : dirOf(s.path);
      const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
      s.slug = slug;
      s.outDir = dir === '' ? slug : `${dir}/${slug}`;
      s.url = `${b.base}/${s.outDir}/`;
      b.bySource.set(s.path, s);
    }
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  {
    const staticPaths = new Set(b.statics.map((f) => f.path));
    for (const s of b.sources) {
      const dir = dirOf(s.path);
      const env = {
        link: (target) => {
          if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
          const hash = target.indexOf('#');
          const rel = hash === -1 ? target : target.slice(0, hash);
          const frag = hash === -1 ? '' : target.slice(hash);
          const path = rel === '' ? null : resolvePath(dir, rel);
          if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
          if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
          b.broken.add(`broken-link ${s.path} -> ${target}`);
          return target;
        },
      };
      const md = renderMarkdown(s.body, env, slugify);
      s.html = md.html;
      s.toc = md.toc;
      s.excerpt = md.excerpt;
      s.words = md.words;
    }
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  {
    const posts = b.sources.filter((s) => s.post);
    posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
    b.posts = posts;
    posts.forEach((p, k) => {
      p.newer = k === 0 ? null : posts[k - 1];
      p.older = k === posts.length - 1 ? null : posts[k + 1];
    });
  }

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  {
    const bySlug = new Map();
    /** A source's tags, each slug once, in its own order. */
    const ownTags = (s) => {
      const seen = new Set();
      const out = [];
      for (const name of s.data.tags ?? []) {
        const slug = slugify(name);
        if (!seen.has(slug)) {
          seen.add(slug);
          out.push(name);
        }
      }
      return out;
    };
    for (const p of b.posts) {
      p.tagRefs = [];
      for (const name of ownTags(p)) {
        const slug = slugify(name);
        if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] });
        const tag = bySlug.get(slug);
        tag.posts.push(p);
        p.tagRefs.push(tag);
      }
    }
    // A page's tags link to the posts' tag of the same slug, and to nothing (url "") where no post has it.
    for (const s of b.sources) {
      if (!s.post) {
        s.tagRefs = ownTags(s).map((name) => {
          const slug = slugify(name);
          return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
        });
      }
    }
    b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
  }

  /** A page's link record as templates read it. */
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

  /** A post's card, as lists show it. */
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });

  /** A page as its layout reads it. A post's card is the one the collections already built. */
  const pageOf = (s) => ({
    ...(s.post ? b.cards.get(s) : cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  /** A tag as templates read it (its posts as cards). */
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) });

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  {
    b.cards = new Map(b.posts.map((p) => [p, cardOf(p)]));
    const site = { title: b.input.site.title, base_url: b.base };
    const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
    const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
    // The site record is one scope shared by every render; each render adds its own
    // names in a child scope instead of spreading the record into a fresh object.
    const baseScope = { vars: { site, tags: allTags, recent }, parent: null };
    const render = (name, vars) => {
      const nodes = b.templates.get(name);
      return nodes === undefined ? null : renderNodes(nodes, { vars, parent: baseScope }, b, 0);
    };
    for (const s of b.sources) b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
    const per = b.input.site.per_page;
    const pages = Math.max(1, Math.ceil(b.posts.length / per));
    const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
    for (let k = 1; k <= pages; k++) {
      const html = render('index', {
        posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
        pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
      });
      if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
    }
    for (const t of b.tags) {
      const html = render('tag', { tag: tagOf(t) });
      if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
    }
    const tagsHtml = render('tags', {});
    if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
    for (const f of b.statics) {
      if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
      else b.output[f.path] = f.content;
    }
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  {
    const lines = [...b.report, ...b.broken].sort(byCodeUnits);
    const pages = b.sources.filter((s) => !s.post).length;
    lines.push(`built ${pages} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
    b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
  }

  return b.output;
}
