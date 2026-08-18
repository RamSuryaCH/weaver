import { join } from 'node:path';
import type { NextConfig } from 'next';

/**
 * The internal `@weaver/*` packages export TypeScript source directly rather
 * than a build output, which keeps the monorepo free of a compile step. Next has
 * to be told to transpile them.
 *
 * `serverExternalPackages` keeps the libSQL native client out of the bundler:
 * it is a Node addon and must be required at runtime.
 */
const config: NextConfig = {
  transpilePackages: ['@weaver/core', '@weaver/config', '@weaver/db'],
  serverExternalPackages: ['@libsql/client', 'libsql', '@libsql/hrana-client', 'drizzle-orm'],
  typedRoutes: false,
  outputFileTracingRoot: join(import.meta.dirname, '../..'),
  eslint: { ignoreDuringBuilds: true },

  /**
   * The internal packages are written as TypeScript ESM, so they import each
   * other with `.js` specifiers that point at `.ts` files on disk. tsx and vitest
   * resolve that natively; webpack has to be told.
   *
   * libSQL is a native Node addon whose package pulls in platform-specific
   * binaries through dynamic requires. Bundling it fails, and there is nothing to
   * gain by trying: it must be loaded at runtime, so it is declared external on
   * the server build explicitly. `serverExternalPackages` does not reach it,
   * because it arrives through a transpiled workspace package.
   */
  webpack: (webpackConfig, { isServer }) => {
    webpackConfig.resolve.extensionAlias = {
      ...webpackConfig.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    };

    if (isServer) {
      webpackConfig.externals = [
        ...(Array.isArray(webpackConfig.externals) ? webpackConfig.externals : []),
        {
          '@libsql/client': 'commonjs @libsql/client',
          libsql: 'commonjs libsql',
        },
      ];
    }

    return webpackConfig;
  },
};

export default config;
