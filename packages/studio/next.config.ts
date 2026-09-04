import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Static export → served by the core on a single origin (the single-binary
  // path from Plan 09).
  output: 'export',
  reactStrictMode: true,
  // Workspace packages are exported as TypeScript source, so they need transpiling.
  // `@enkaku/ui` is Studio's own component library, extracted so plugins can
  // import the same components (plan 111 §3.3). It is a ROOT-TypeScript
  // package and crosses into Studio's TypeScript 5 exactly the way
  // `@enkaku/protocol` already does — see CLAUDE.md's "two TypeScripts" rule.
  transpilePackages: ['@enkaku/protocol', '@enkaku/ui', '@enkaku/expr'],
}

export default nextConfig
