/**
 * Builds the catalog UI into ../catalog/ui, served by catalog/server.mjs at
 * /_catalog/ui/ (the master owns only "/", "/_catalog/**" and "/apps/**", so the
 * UI's assets can never collide with a child app's own "/assets/…").
 *
 * Built on a laptop and COMMITTED: the Apps container installs nothing for the
 * master, and `databricks sync` would drop an ignored build directory.
 */
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  base: '/_catalog/ui/',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  build: {
    outDir: path.resolve(__dirname, '../catalog/ui'),
    emptyOutDir: true,
    assetsDir: 'assets',
    sourcemap: false,
  },
  server: {
    port: 5291,
    proxy: { '/_catalog/api': 'http://127.0.0.1:8790', '/_catalog/shim.js': 'http://127.0.0.1:8790', '/apps': { target: 'http://127.0.0.1:8790', ws: true } },
  },
});
