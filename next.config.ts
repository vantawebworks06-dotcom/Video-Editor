import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The font route reads the render library's OFL fonts at runtime (a dynamic path Next can't
  // trace), so they are bundled with it explicitly — the live preview draws graphics with them.
  outputFileTracingIncludes: {
    "/api/fonts/\[file\]": ["./assets/library/fonts/**/*"],
  },
};

export default nextConfig;
