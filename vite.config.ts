import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Dev-only Vite plugin: reroute imports that resolve to a file inside
// api/library/ to a gitignored symlink at src/_apilibrary_dev/. In dev,
// Vite's URL for those modules would otherwise be /api/library/*.ts —
// which `vercel dev` intercepts as a serverless-function invocation and
// 500s because the files are shared library modules (no handler default
// export). Rewriting the URL isn't feasible: Vercel dev's function
// auto-detection preempts rewrites, and the `functions.excludeFiles`
// config doesn't stop the scan.
//
// Rerouting at the resolver level bypasses /api/ URLs entirely — the
// browser requests /src/_apilibrary_dev/*.ts which Vite serves normally.
// The plugin's `apply: 'serve'` gate means it NEVER runs during
// `vite build`, so the production bundle resolves the exact same file
// the exact same way it did before this plugin existed. Byte-identical
// prod output verified via diff.
//
// The symlink target `src/_apilibrary_dev` is gitignored and only
// exists on Rob's dev machine.
function devApiLibraryReroute(rootDir: string): Plugin {
  const canonicalDir = path.resolve(rootDir, 'api/library');
  const symlinkDir = path.resolve(rootDir, 'src/_apilibrary_dev');
  return {
    name: 'planmatch-dev-api-library-reroute',
    apply: 'serve',
    enforce: 'pre',
    async resolveId(source, importer) {
      if (!importer) return null;
      // Resolve using Vite's default logic first, then check whether
      // the result lives inside api/library/. If yes, rewrite to the
      // symlinked path so Vite serves it as /src/_apilibrary_dev/*.
      const resolved = await this.resolve(source, importer, { skipSelf: true });
      if (!resolved || resolved.external) return null;
      const abs = resolved.id.split('?')[0];
      if (!abs.startsWith(canonicalDir + path.sep)) return null;
      const rel = path.relative(canonicalDir, abs);
      const rerouted = path.join(symlinkDir, rel);
      return rerouted + resolved.id.slice(abs.length); // preserve any ?query
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    ...(mode === 'development' ? [devApiLibraryReroute(__dirname)] : []),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
  },
  build: {
    // Production source maps — Vite equivalent of Next.js's
    // productionBrowserSourceMaps. Lets Sentry / browser DevTools map
    // minified frames back to TS/TSX source. The dist/.map files ship
    // alongside the JS bundle; Vercel serves them on demand only when
    // DevTools requests them, so users never pay for the download.
    sourcemap: true,
  },
}));
