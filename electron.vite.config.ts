import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve('src/main/index.ts') } } },
  },
  preload: {
    // Sandboxed preloads can't require packages, so bundle the browser-action element in.
    plugins: [externalizeDepsPlugin({ exclude: ['electron-chrome-extensions'] })],
    build: {
      rollupOptions: {
        input: { ui: resolve('src/preload/ui.ts'), page: resolve('src/preload/page.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    build: { minify: true, rollupOptions: { input: { index: resolve('src/renderer/index.html') } } },
  },
})
