import { ts } from '../data/derive';

// Text helpers shared by every panel. Everything that reaches innerHTML goes
// through esc() first; md() renders a small, safe Markdown subset on top.

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Markdown-ish text flattened to one line. */
export function plain(s: string | null | undefined): string {
  return String(s ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

/** The first prose paragraph of a reply (skipping code and tables). */
export function firstParagraph(text: string | null | undefined, n = 260): string {
  const paras = String(text ?? '').trim().split(/\n\s*\n/);
  const para = paras.find((p) => plain(p) && !/^\s*\|/.test(p) && !/^```/.test(p.trim())) ?? '';
  return clip(plain(para), n);
}

/** Inline Markdown on already-escaped text. Links open in a new tab, http(s) only. */
export function inlineMd(escaped: string): string {
  return escaped
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

const BLOCK_START = /^(```|\s*\||\s*[-*•]\s+|\s*\d+[.)]\s+|#{1,6}\s)/;

function tableHTML(lines: string[]): string {
  const cells = lines
    .filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r))
    .map((r) =>
      r
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((c) => inlineMd(esc(c.trim()))),
    );
  if (!cells.length) return '';
  const [head, ...body] = cells;
  return `<div class="md__table"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${body
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
    .join('')}</tbody></table></div>`;
}

/** A small, safe Markdown subset: everything is escaped first. */
export function md(src: string | null | undefined): string {
  const lines = String(src ?? '').replace(/\r/g, '').split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i += 1;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
    } else if (/^\s*\|/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) buf.push(lines[i++]);
      out.push(tableHTML(buf));
    } else if (/^\s*[-*•]\s+/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) buf.push(lines[i++].replace(/^\s*[-*•]\s+/, ''));
      out.push(`<ul>${buf.map((b) => `<li>${inlineMd(esc(b))}</li>`).join('')}</ul>`);
    } else if (/^\s*\d+[.)]\s+/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) buf.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ''));
      out.push(`<ol>${buf.map((b) => `<li>${inlineMd(esc(b))}</li>`).join('')}</ol>`);
    } else if (/^#{1,6}\s/.test(line)) {
      out.push(`<h4>${inlineMd(esc(line.replace(/^#+\s*/, '')))}</h4>`);
      i += 1;
    } else if (!line.trim()) {
      i += 1;
    } else {
      const buf: string[] = [];
      while (i < lines.length && lines[i].trim() && !BLOCK_START.test(lines[i])) buf.push(lines[i++]);
      out.push(`<p>${inlineMd(esc(buf.join('\n'))).replace(/\n/g, '<br>')}</p>`);
    }
  }
  return out.join('');
}

// ---------------------------------------------------------------- time

/** Compact duration: 45s, 12m, 3h, 2d, 3w. */
export function span(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h`;
  const d = Math.floor(h / 24);
  return d < 14 ? `${d} d` : `${Math.floor(d / 7)} wk`;
}

export function ago(ms: number): string {
  if (ms < 45000) return 'just now';
  return `${span(ms)} ago`;
}

/** A running clock for turn times: 42s, 3m 07s, 1h 04m. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export type TimeFormat = 'ago' | 'clock' | 'idle' | 'wait' | 'short' | 'until';

export function fmtTime(fmt: TimeFormat, iso: string): string {
  const d = Date.now() - ts(iso);
  switch (fmt) {
    case 'clock':
      return clock(d);
    case 'idle':
      return `idle ${span(d)}`;
    case 'wait':
      return `waiting ${span(d)}`;
    case 'short':
      return span(d);
    case 'until':
      return countdown(-d);
    default:
      return ago(d);
  }
}

/** A time that keeps itself current: refreshTimes() rewrites every one on screen. */
export function timeTag(iso: string | null | undefined, fmt: TimeFormat, cls = ''): string {
  if (!iso) return '';
  return `<time${cls ? ` class="${cls}"` : ''} datetime="${esc(iso)}" data-fmt="${fmt}">${esc(fmtTime(fmt, iso))}</time>`;
}

export function refreshTimes(root: ParentNode = document) {
  for (const el of root.querySelectorAll<HTMLTimeElement>('time[data-fmt]')) {
    const next = fmtTime(el.dataset.fmt as TimeFormat, el.dateTime);
    if (el.textContent !== next) el.textContent = next;
  }
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function shortPath(p: string | null | undefined): string {
  if (!p) return '';
  return p.replace(/^\/Users\/[^/]+/, '~');
}

export const MODE_LABELS: Record<string, string> = {
  auto: 'auto mode',
  acceptEdits: 'accepting edits',
  plan: 'plan mode',
  bypassPermissions: 'bypassing permissions',
};
