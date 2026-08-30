/** @type {import('next').NextConfig} */
const nextConfig = {
  // `output: "standalone"` is deliberately NOT set.
  //
  // It was set previously to shrink the deploy tree, but the start command is
  // `next start`, and next start does not use the standalone output at all —
  // Next.js prints a warning saying exactly that. The bundle was built and
  // never served, so it bought nothing.
  //
  // Turn it back on ONLY together with a run command of
  // `node .next/standalone/server.js`, which also means copying .next/static
  // and public/ into the standalone tree. Worth doing for a Dockerfile deploy;
  // not worth it for a buildpack host that runs `npm start`.
  //
  // No experimental.optimizePackageImports either: measured against a full
  // build it moved no route's bundle by a single byte (Next 14.2 already
  // optimizes lucide-react and date-fns), while adding @tanstack/react-table
  // broke the build outright.
};

export default nextConfig;
