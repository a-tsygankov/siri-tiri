// Declared under the global Cloudflare namespace, the convention `wrangler types`
// uses and the one the vitest plugin's `env` import is typed against.
declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      CLIPS: R2Bucket;
      ADMIN_SECRET: string;
      ALLOWED_ORIGINS: string;
      ENVIRONMENT: string;
    }
  }
}
export type Env = Cloudflare.Env;

export const WORKER_VERSION = '0.1.0';
export const PROTOCOL_VERSION = 1;
export const MIGRATION = 1;

export const MAX_MESSAGES_PER_REQUEST = 50;
export const MAX_MESSAGES_BODY_BYTES = 512 * 1024;
export const MAX_CLIP_BYTES = 4 * 1024 * 1024;
export const PAIRING_CODE_TTL_MS = 15 * 60 * 1000;
export const PAIRING_CODE_MAX_ATTEMPTS = 5;
