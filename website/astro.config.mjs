import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  vite: {
    plugins: [tailwindcss()],
    worker: {
      format: "es",
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes("/@tensorflow/") || id.includes("/tfjs-backend-")) {
              return "tfjs";
            }
          },
        },
      },
    },
    server: {
      headers: {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
      },
    },
    preview: {
      headers: {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
      },
    },
  },
});
