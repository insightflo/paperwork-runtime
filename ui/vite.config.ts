import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// 무거운 vendor 그룹만 안정적인 수동 청크로 분리한다(캐시 안정화 + 500kB 경고 해소).
// 앱 코드와 비동기 전용 라이브러리(mermaid, katex 등)는 자동 청크에 맡긴다.
// CodeMirror 언어 패키지(@codemirror/lang-*, language-data)는 언어별 동적 분할을 유지해야 하므로
// 코어 런타임만 수동 청크로 모은다.
function vendorManualChunks(id: string): string | undefined {
  if (!id.includes("node_modules")) return undefined;
  if (/[\\/]node_modules[\\/](react|react-dom|scheduler|react-router|react-router-dom)[\\/]/.test(id)) return "vendor-react";
  if (/[\\/]node_modules[\\/]@tanstack[\\/]/.test(id)) return "vendor-query";
  if (/[\\/]node_modules[\\/]@dnd-kit[\\/]/.test(id)) return "vendor-dnd";
  if (/[\\/]node_modules[\\/](@radix-ui|radix-ui|@floating-ui|react-remove-scroll(-bar)?)[\\/]/.test(id)) return "vendor-radix";
  if (/[\\/]node_modules[\\/](lexical|@lexical[\\/][^\\/]+)[\\/]/.test(id)) return "vendor-lexical";
  // @mdxeditor/editor 본체(~160kB)와 나머지 의존성은 자동 MarkdownEditor 비동기 청크에 둔다.
  if (/[\\/]node_modules[\\/](@codemirror[\\/](state|view|commands|language|search|autocomplete|lint|history|fold)|@lezer[\\/](lr|common|highlight)|@marijn[\\/][^\\/]+|crelt|prismjs|style-mod|w3c-keyname)[\\/]/.test(id)) return "vendor-codemirror";
  return undefined;
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: vendorManualChunks,
      },
    },
  },
  server: {
    port: 5274,
    proxy: {
      "/api": {
        target: "http://localhost:3200",
        ws: true,
      },
      "/_plugins": {
        target: "http://localhost:3200",
      },
    },
  },
});
