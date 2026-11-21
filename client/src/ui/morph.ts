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
  patchChildren(root, tpl.content);
}

function patchChildren(target: Node, source: Node) {
  const have = Array.from(target.childNodes);
  const want = Array.from(source.childNodes);
  for (let i = 0; i < want.length; i++) {
    const a = have[i];
    const b = want[i];
    if (!a) target.appendChild(b);
    else if (!sameThing(a, b)) target.replaceChild(b, a);
    else if (a.nodeType === Node.ELEMENT_NODE) {
      patchAttributes(a as Element, b as Element);
      patchChildren(a, b);
    } else if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue;
  }
  for (let i = have.length - 1; i >= want.length; i--) target.removeChild(have[i]);
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
