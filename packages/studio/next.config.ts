import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Static export → di-serve core di satu origin (jalur single-binary Plan 09).
  output: 'export',
  reactStrictMode: true,
  // Package workspace diekspor sebagai source TypeScript, jadi harus di-transpile.
  transpilePackages: ['@enkaku/protocol'],
}

export default nextConfig
