import type { NextConfig } from 'next';

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(self)' },
];

const config: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ['@ros/core', '@ros/modules', '@ros/adapters', '@ros/runtime'],
  serverExternalPackages: ['pg', 'kysely'],
  // Several development servers can run side by side from one checkout, each with its own build directory.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  poweredByHeader: false,
  // The repo has its own session guide at the root.
  agentRules: false,
  experimental: {
    serverActions: {
      // The media library takes images up to 8 MB (website.MAX_IMAGE_BYTES); the default of 1 MB
      // refused them before the service saw them. The extra megabyte is the multipart framing.
      // The proxy buffers request bodies up to its own default of 10 MB, which covers this.
      bodySizeLimit: '9mb',
    },
  },
  typescript: {
    // Types are checked by `pnpm typecheck` (tsc), which is one of the gates.
    ignoreBuildErrors: true,
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default config;
