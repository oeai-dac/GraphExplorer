import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Separate dev port from OntoCartographer Studio (3000) so both can run
// side by side. No backend proxy yet -- the Explorer is read-only for now
// (loads a static Graph-JSON file or receives one via postMessage).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3001,
  },
})
