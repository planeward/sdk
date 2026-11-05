import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    server: "src/server.ts",
    openapi: "src/openapi.ts",
  },
  format: "esm",
  dts: true,
  clean: true,
  target: "es2022",
  platform: "neutral",
  fixedExtension: false,
});
