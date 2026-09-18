import { defineConfig } from 'vite'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { cloudflare } from '@cloudflare/vite-plugin'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // Runs the app Worker plus the three service Workers in the real workerd
    // runtime during `vite dev`, wired through their Service Bindings.
    cloudflare({
      auxiliaryWorkers: [
        { configPath: './services/calc/wrangler.jsonc' },
        { configPath: './services/cad/wrangler.jsonc' },
        { configPath: './services/gis/wrangler.jsonc' },
      ],
    }),
  ],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  server: { port: 5184 },
})
