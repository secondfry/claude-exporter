// Theme initialization for popup
// This runs immediately to sync with browse window theme preference

function applyTheme(theme: string | null): void {
  if (theme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else {
    document.documentElement.removeAttribute('data-theme'); // dark
  }
}

function toggleTheme(): void {
  const isLight =
    document.documentElement.getAttribute('data-theme') === 'light';
  const next = isLight ? 'dark' : 'light';
  applyTheme(next);
  localStorage.setItem('theme', next);
}

function initTheme(): void {
  // Check if user has set a theme in browse window (stored in localStorage)
  const savedTheme = localStorage.getItem('theme');

  if (savedTheme) {
    // Use saved theme from browse window
    applyTheme(savedTheme);
  } else {
    // Fall back to system preference
    const prefersDark = window.matchMedia(
      '(prefers-color-scheme: dark)',
    ).matches;
    const prefersLight = window.matchMedia(
      '(prefers-color-scheme: light)',
    ).matches;

    // Default to dark unless system explicitly prefers light
    if (prefersLight && !prefersDark) {
      document.documentElement.setAttribute('data-theme', 'light');
    }
  }

  // Listen for storage changes (when browse window changes theme)
  window.addEventListener('storage', (e) => {
    if (e.key === 'theme') {
      applyTheme(e.newValue);
    }
  });

  // Listen for system theme changes (only if no saved preference)
  window
    .matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', (e) => {
      if (!localStorage.getItem('theme') && e.matches) {
        document.documentElement.removeAttribute('data-theme');
      }
    });

  window
    .matchMedia('(prefers-color-scheme: light)')
    .addEventListener('change', (e) => {
      if (!localStorage.getItem('theme') && e.matches) {
        document.documentElement.setAttribute('data-theme', 'light');
      }
    });
}

export { initTheme, toggleTheme };
