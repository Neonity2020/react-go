import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://neonity2020.github.io',
  base: '/go-game',
  vite: {
    plugins: [tailwindcss()],
  },
});
