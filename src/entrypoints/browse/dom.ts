// Typed lookups for browse.html's elements.
//
// `getElementById` returns `HTMLElement | null`, so every call site used to end
// in `as HTMLInputElement` — an assertion sitting exactly where the data is
// least trustworthy, since the element may have been renamed in the HTML and
// the compiler would say nothing. `instanceof` checks the same thing for real.
//
// Two flavours on purpose: `get*` for elements the page can run without, and
// `require*` for the ones browse.html guarantees — those throw loudly rather
// than letting a markup rename degrade into a silently dead button.

const getElement = (id: string): HTMLElement | null => {
  return document.getElementById(id);
};

const getButton = (id: string): HTMLButtonElement | null => {
  const element = document.getElementById(id);
  return element instanceof HTMLButtonElement ? element : null;
};

const getInput = (id: string): HTMLInputElement | null => {
  const element = document.getElementById(id);
  return element instanceof HTMLInputElement ? element : null;
};

const requireElement = (id: string): HTMLElement => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`browse.html is missing #${id}`);
  return element;
};

const requireButton = (id: string): HTMLButtonElement => {
  const element = requireElement(id);
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`browse.html's #${id} is not a <button>`);
  }
  return element;
};

const requireInput = (id: string): HTMLInputElement => {
  const element = requireElement(id);
  if (!(element instanceof HTMLInputElement)) {
    throw new Error(`browse.html's #${id} is not an <input>`);
  }
  return element;
};

const requireSelect = (id: string): HTMLSelectElement => {
  const element = requireElement(id);
  if (!(element instanceof HTMLSelectElement)) {
    throw new Error(`browse.html's #${id} is not a <select>`);
  }
  return element;
};

export {
  getButton,
  getElement,
  getInput,
  requireButton,
  requireElement,
  requireInput,
  requireSelect,
};
