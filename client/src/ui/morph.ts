// Updates a container to new markup by changing only what differs, instead of
// replacing its innerHTML. Replacing rebuilt every element on each update (a
// countdown tick, a new snapshot, a click), so a scrolled card jumped back to
// the top, and a typed reply, a chosen option or the keyboard focus were lost.
// Patching keeps the same elements, so all of that survives.
//
// Listeners must be delegated to the container (they are, everywhere in ui/).

/** Attributes that say which thing an element is: a different one is replaced, not patched. */
const IDENTITY = ['id', 'data-id', 'data-pick', 'data-key', 'data-plot'];

export function morph(root: Element, html: string): void {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  // Moving an element (a reordered row) drops its focus in browsers: put it back.
  const active = document.activeElement as HTMLElement | null;
  const hadFocus = Boolean(active && active !== document.body && root.contains(active));
  patchChildren(root, tpl.content);
  if (hadFocus && active && active.isConnected && root.contains(active) && document.activeElement !== active) active.focus({ preventScroll: true });
}

function patchChildren(target: Node, source: Node) {
  const want = Array.from(source.childNodes);
  // Keyed children (a row with data-pick, a card with data-id...) are found by
  // key wherever they now sit and moved into place, so a list that reorders
  // keeps its elements (and the keyboard focus, and any state in them) instead
  // of rebuilding every row after the first change.
  const keyed = new Map<string, Element>();
  for (const n of Array.from(target.childNodes)) {
    const k = keyOf(n);
    if (k) keyed.set(k, n as Element);
  }
  let cursor: ChildNode | null = target.firstChild;
  for (const b of want) {
    const k = keyOf(b);
    let a: ChildNode | null = cursor;
    if (k) {
      const match = keyed.get(k);
      if (match) {
        keyed.delete(k);
        if (match !== cursor) target.insertBefore(match, cursor);
        a = match;
      } else {
        target.insertBefore(b, cursor);
        continue;
      }
    } else if (!a || keyOf(a) || !sameThing(a, b)) {
      if (a && !keyOf(a) && a.nodeType === b.nodeType && a.nodeType !== Node.ELEMENT_NODE) {
        // Text or comment in the same place: update it.
      } else {
        target.insertBefore(b, cursor);
        continue;
      }
    }
    if (a.nodeType === Node.ELEMENT_NODE) {
      patchAttributes(a as Element, b as Element);
      patchChildren(a, b);
    } else if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue;
    cursor = a.nextSibling;
  }
  // Whatever is left after the last wanted child, and keyed children no longer wanted, go.
  while (cursor) {
    const next: ChildNode | null = cursor.nextSibling;
    target.removeChild(cursor);
    cursor = next;
  }
  for (const n of keyed.values()) if (n.parentNode === target) target.removeChild(n);
}

/**
 * An element's identity (see IDENTITY), or null for anonymous nodes. A wrapper
 * with a single keyed child (a list's <li> around its row button) takes that
 * child's key, so rows move with their wrappers instead of swapping contents.
 */
function keyOf(n: Node): string | null {
  if (n.nodeType !== Node.ELEMENT_NODE) return null;
  const e = n as Element;
  for (const k of IDENTITY) {
    const v = e.getAttribute(k);
    if (v !== null) return `${e.tagName}|${k}=${v}`;
  }
  if (e.childElementCount === 1) {
    const inner = keyOf(e.firstElementChild!);
    if (inner) return `${e.tagName}>${inner}`;
  }
  return null;
}

function sameThing(a: Node, b: Node): boolean {
  if (a.nodeType !== b.nodeType) return false;
  if (a.nodeType !== Node.ELEMENT_NODE) return true;
  const ea = a as Element;
  const eb = b as Element;
  if (ea.tagName !== eb.tagName) return false;
  return IDENTITY.every((k) => ea.getAttribute(k) === eb.getAttribute(k));
}

function patchAttributes(a: Element, b: Element) {
  // A checkbox or radio follows the markup only when the markup changed its
  // `checked`; otherwise what the person clicked stays.
  const checkedChanged = a instanceof HTMLInputElement && a.hasAttribute('checked') !== b.hasAttribute('checked');
  for (const { name } of Array.from(a.attributes)) {
    // A <details> the person opened or closed stays that way.
    if (name === 'open' && a.tagName === 'DETAILS') continue;
    if (!b.hasAttribute(name)) a.removeAttribute(name);
  }
  for (const { name, value } of Array.from(b.attributes)) {
    if (a.getAttribute(name) === value) continue;
    if (name === 'open' && a.tagName === 'DETAILS') continue;
    a.setAttribute(name, value);
  }
  if (checkedChanged) (a as HTMLInputElement).checked = b.hasAttribute('checked');
}
