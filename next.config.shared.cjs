// Next options shared by the dev server and a later packaged build.
// Adapted from node-banana (MIT, © William Falloon).
/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // The agent spawns the Claude Code and Codex CLIs, which these packages locate
  // relative to their own install path; bundling them breaks that lookup.
  serverExternalPackages: ['@anthropic-ai/claude-agent-sdk', '@openai/codex', 'unpdf', 'mammoth'],
  images: { unoptimized: true },
  devIndicators: false,
  experimental: { serverActions: { bodySizeLimit: '100mb' } },
};

module.exports = config;
