import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const shared = resolve(import.meta.dirname, 'src/shared')

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': shared } },
    build: {
      // Dependencies are bundled into out/main, so the app ships no node_modules
      // (and none of their CLIs, docs or test files). ws's optional native
      // add-ons stay outside: they aren't installed, and ws works without them.
      externalizeDeps: false,
      rollupOptions: { external: ['bufferutil', 'utf-8-validate'] }
    }
  },
  preload: {
    resolve: { alias: { '@shared': shared } },
    build: {
      externalizeDeps: true,
      rollupOptions: {
        // Sandboxed preload scripts must be CommonJS.
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    root: resolve(import.meta.dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@': resolve(import.meta.dirname, 'src/renderer/src'),
        '@shared': shared
      }
    },
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, 'src/renderer/index.html'),
          // The phone companion (served by the main process, see src/main/mobile).
          mobile: resolve(import.meta.dirname, 'src/renderer/mobile.html')
        }
      }
    }
  }
})
