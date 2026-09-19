import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

export default defineConfig({
  base: './',
  plugins: [{
    name: 'include-font-license',
    generateBundle() {
      for (const name of ['Lato-OFL.txt', 'Lato-WOFF2.txt']) {
        this.emitFile({ type: 'asset', fileName: `assets/${name}`, source: readFileSync(new URL(`./assets/${name}`, import.meta.url), 'utf8') });
      }
    },
  }],
  build: {
    rolldownOptions: {
      input: Object.fromEntries(
        ['index', 'registration', 'privacy', 'consent'].map((page) => [
          page,
          fileURLToPath(new URL(`./${page}.html`, import.meta.url)),
        ]),
      ),
    },
  },
});
