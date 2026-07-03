import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const workspaceDependency = (path: string) =>
  fileURLToPath(new URL(`../../node_modules/${path}`, import.meta.url))

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: /^react$/, replacement: workspaceDependency('react/index.js') },
      { find: /^react\/jsx-runtime$/, replacement: workspaceDependency('react/jsx-runtime.js') },
      { find: /^react\/jsx-dev-runtime$/, replacement: workspaceDependency('react/jsx-dev-runtime.js') },
      { find: /^react-dom$/, replacement: workspaceDependency('react-dom/index.js') },
      { find: /^react-dom\/client$/, replacement: workspaceDependency('react-dom/client.js') },
      { find: /^react-dom\/server$/, replacement: workspaceDependency('react-dom/server.browser.js') },
      { find: /^lucide-react$/, replacement: workspaceDependency('lucide-react/dist/esm/lucide-react.js') },
    ],
    dedupe: ['react', 'react-dom'],
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'node',
    globals: true,
  },
})
