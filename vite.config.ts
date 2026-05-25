import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  server:
    command === "serve"
      ? {
          headers: {
            "Cache-Control": "no-store, max-age=0",
            Expires: "0",
            Pragma: "no-cache"
          }
        }
      : undefined
}));
