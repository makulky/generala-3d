import { defineConfig } from 'vite';

// Three.js, la física y PeerJS ya van en trozos aparte por los import() dinámicos.
export default defineConfig({
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 900,
  },
});
