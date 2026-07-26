// Typed reads for the options page's form controls.
//
// `getElementById` returns `HTMLElement | null` and every call site used to end
// in `as HTMLInputElement | null` — an assertion sitting exactly where the data
// is least trustworthy: the element may be absent, or renamed in options.html,
// and the compiler would say nothing either way. `instanceof` checks the same
// claim for real, and a missing control degrades to "no value" instead of a
// null-property crash.
//
// A near-twin of popup/dom.ts, deliberately not shared: entrypoints do not
// import each other, and the two pages have different controls.

const getInput = (id: string): HTMLInputElement | null => {
  const element = document.getElementById(id);
  return element instanceof HTMLInputElement ? element : null;
};

const getSelect = (id: string): HTMLSelectElement | null => {
  const element = document.getElementById(id);
  return element instanceof HTMLSelectElement ? element : null;
};

/** The trimmed value of a text input, or '' when it is absent or empty. */
const readInputValue = (id: string): string => {
  return getInput(id)?.value.trim() ?? '';
};

const setInputValue = (id: string, value: string): void => {
  const input = getInput(id);
  if (input) input.value = value;
};

const setSelectValue = (id: string, value: string): void => {
  const select = getSelect(id);
  if (select) select.value = value;
};

/**
 * The value of whichever control fired the event.
 *
 * `event.target` is typed `EventTarget | null`, so reading `.value` off it
 * needed an assertion per listener. Undefined here means the event came from
 * something with no value, which every caller can simply ignore.
 */
const eventValue = (event: Event): string | undefined => {
  const target = event.target;
  if (target instanceof HTMLInputElement) return target.value;
  if (target instanceof HTMLSelectElement) return target.value;
  return undefined;
};

/** Sets the text and status class of one of the page's status lines. */
const showStatus = (
  elementId: string,
  message: string,
  type: 'error' | 'success',
): void => {
  const statusEl = document.getElementById(elementId);
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
};

const hideStatus = (elementId: string): void => {
  const statusEl = document.getElementById(elementId);
  if (!statusEl) return;
  statusEl.className = 'status';
};

const setText = (elementId: string, text: string): void => {
  const element = document.getElementById(elementId);
  if (!element) return;
  element.textContent = text;
};

const onClick = (id: string, handler: () => void): void => {
  document.getElementById(id)?.addEventListener('click', handler);
};

const onChange = (id: string, handler: (event: Event) => void): void => {
  document.getElementById(id)?.addEventListener('change', handler);
};

export {
  eventValue,
  getInput,
  getSelect,
  hideStatus,
  onChange,
  onClick,
  readInputValue,
  setInputValue,
  setSelectValue,
  setText,
  showStatus,
};
