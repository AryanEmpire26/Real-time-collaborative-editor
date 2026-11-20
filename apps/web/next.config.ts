import type { NextConfig } from 'next';
import path from 'node:path';

const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: path.join(__dirname, '../..'),
  turbopack: { root: path.join(__dirname, '../..') },
  devIndicators: false,
  async rewrites() {
    return process.env.NODE_ENV === 'development'
      ? [{ source: '/api/:path*', destination: `${process.env.MERGEPAD_API_URL ?? 'http://localhost:4000'}/api/:path*` }]
      : [];
  },
};

export default config;
