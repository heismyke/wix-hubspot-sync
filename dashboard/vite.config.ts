import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/dashboard/',
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:3000', '/oauth': 'http://localhost:3000' } },
});
