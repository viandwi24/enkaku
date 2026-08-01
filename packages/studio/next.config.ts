import type { NextConfig } from 'next'

const config: NextConfig = {
  // Static export → di-serve core di satu origin (jalur single-binary Plan 09).
  output: 'export',
  reactStrictMode: true,
  // Package workspace di-transpile karena diekspor sebagai source TS.
  transpilePackages: ['@enkaku/protocol'],
}

export default config
