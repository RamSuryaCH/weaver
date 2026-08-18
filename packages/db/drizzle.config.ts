import { defineConfig } from 'drizzle-kit';

/**
 * Migrations are generated from `src/schema.ts` and committed, so cloning the
 * repo and running `pnpm db:push` is enough to get a working database with no
 * network access and no drizzle-kit invocation.
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema.ts',
  out: './migrations',
});
