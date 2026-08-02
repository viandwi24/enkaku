import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Static export → served by the core on a single origin (the single-binary
  // path from Plan 09).
  output: 'export',
  reactStrictMode: true,
  // Workspace packages are exported as TypeScript source, so they need transpiling.
  transpilePackages: ['@enkaku/protocol'],
}

export default nextConfig
