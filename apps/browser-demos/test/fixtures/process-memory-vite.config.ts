import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// This source component has no kernel, SDK-program or VFS dependency. Keep
// its disposable Worker checks available before provisioning those products.
export default defineConfig({
  root: fileURLToPath(new URL('../../', import.meta.url)),
  appType: 'mpa',
  optimizeDeps: { entries: ['test/fixtures/process-address-space.html'] },
  server: {
    hmr: false,
    fs: { allow: [fileURLToPath(new URL('../../../../', import.meta.url))] },
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
  },
});
