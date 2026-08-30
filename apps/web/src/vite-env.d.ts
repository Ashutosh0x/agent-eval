/// <reference types="vite/client" />

/**
 * Frontend environment variables.
 *
 * Declared explicitly rather than relying on the loose index signature Vite
 * provides, so a typo in a variable name is a compile error rather than a
 * silent `undefined` at runtime.
 *
 * Everything here is PUBLIC. Vite compiles `VITE_` variables into the browser
 * bundle, where any visitor can read them. A secret added to this interface
 * would be published on the next deploy — provider keys, the encryption key
 * and any database credential stay server-side, and there is no mechanism in
 * this app for the browser to receive one.
 */
interface ImportMetaEnv {
  /**
   * Origin of the control plane, e.g. https://api.example.com.
   *
   * Empty in development, where Vite proxies /v1 to localhost:8080. Required
   * in a deployed build, because there is no proxy there and a relative /v1
   * would resolve against the static host, which serves no API.
   */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
