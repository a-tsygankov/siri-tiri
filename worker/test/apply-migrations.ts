import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach } from 'vitest';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// Storage is shared between the tests of one file, so every test starts from empty tables
// and an empty bucket.
const TABLES = ['devices', 'pairing_codes', 'messages', 'review_chain', 'clips', 'sync_log', 'counters'];
beforeEach(async () => {
  await env.DB.batch(TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.prepare("DELETE FROM sqlite_sequence WHERE name = 'sync_log'").run().catch(() => {});
  const listed = await env.CLIPS.list();
  if (listed.objects.length) await env.CLIPS.delete(listed.objects.map((o) => o.key));
});
