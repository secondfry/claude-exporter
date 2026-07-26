// Typed reads for the popup's form controls.
//
// `getElementById` returns `HTMLElement | null`, so every call site used to end
// in `as HTMLInputElement` — an assertion sitting exactly where the data is
// least trustworthy (the element may be absent, or renamed in the HTML, and the
// compiler would say nothing). `instanceof` checks the same thing for real.

const readCheckbox = (id: string): boolean | undefined => {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLInputElement)) return undefined;
  return element.checked;
};

const readSelectValue = (id: string): string | undefined => {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLSelectElement)) return undefined;
  return element.value;
};

const getButton = (id: string): HTMLButtonElement | null => {
  const element = document.getElementById(id);
  return element instanceof HTMLButtonElement ? element : null;
};

export { getButton, readCheckbox, readSelectValue };
