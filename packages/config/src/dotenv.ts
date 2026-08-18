/**
 * Loads `.env` if it exists, using Node's built-in parser.
 *
 * No dotenv dependency: `process.loadEnvFile` has been available since Node
 * 20.12 and Weaver requires Node 22. Missing files are not an error, because
 * replay mode needs no configuration at all — that is the point of it.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadDotEnv(path = '.env'): boolean {
  const absolute = resolve(path);
  if (!existsSync(absolute)) return false;
  process.loadEnvFile(absolute);
  return true;
}
