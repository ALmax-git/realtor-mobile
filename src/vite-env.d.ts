/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Base URL of the Realtor backend API (Laravel + Sanctum), e.g.
   * "https://realtor.example.com". No trailing slash needed.
   * Defaults to http://localhost:8000 for local dev against realtor-web.
   */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
