/** @type {import('next').NextConfig} */
const nextConfig = {
  // Render deploys the built app; standalone traces the server's real imports
  // and drops the rest of node_modules, so the image — and the cold start it
  // feeds — is much smaller.
  output: "standalone",
  // No experimental.optimizePackageImports here on purpose. Next 14.2 already
  // applies it to lucide-react and date-fns by default, which are the only
  // barrel-heavy packages this app uses; adding the Radix and cmdk packages on
  // top was measured against a full build and moved no route's bundle by a
  // single byte, while adding @tanstack/react-table broke the build outright
  // (its published ESM bundle is not parsed as a module by the optimizer).
};

export default nextConfig;
