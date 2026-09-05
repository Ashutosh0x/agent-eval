import '@testing-library/jest-dom/vitest';

// jsdom has no matchMedia, and the theme resolver calls it on mount.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }),
});

/**
 * localStorage.
 *
 * Node 26 defines a built-in `localStorage` global that is inert unless the
 * runtime was started with --localstorage-file, and it takes precedence over
 * the one jsdom installs. The result is that `window.localStorage` is
 * undefined here while working perfectly in a browser — so anything reading a
 * token would throw only under test. This is a small in-memory stand-in with
 * the parts of the Storage interface the app actually uses.
 */
function createStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key: string) => entries.get(key) ?? null,
    key: (index: number) => [...entries.keys()][index] ?? null,
    removeItem: (key: string) => void entries.delete(key),
    setItem: (key: string, value: string) => void entries.set(key, String(value)),
  } as Storage;
}

const storage = createStorage();
for (const target of [window, globalThis]) {
  Object.defineProperty(target, 'localStorage', {
    configurable: true,
    writable: true,
    value: storage,
  });
}
