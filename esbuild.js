// Bundles three targets with esbuild:
//   - src/extension.ts        -> dist/extension.js      (Node, VS Code extension host)
//   - src/webview/main.ts     -> dist/webview.js        (browser, runs inside the webview)
//   - src/builder/worker.ts   -> dist/builder.worker.js (Node worker thread, off-main-thread build)
const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: "info",
};

async function main() {
  const extension = await esbuild.context({
    ...shared,
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
    platform: "node",
    format: "cjs",
    external: ["vscode"],
  });

  const webview = await esbuild.context({
    ...shared,
    entryPoints: ["src/webview/main.ts"],
    outfile: "dist/webview.js",
    platform: "browser",
    format: "iife",
    // Lets the bundle branch on build type: production strips the dev-only sigma
    // window handles used by the headless harness, and dead-code-eliminates them.
    define: { "process.env.NODE_ENV": production ? '"production"' : '"development"' },
  });

  const worker = await esbuild.context({
    ...shared,
    entryPoints: ["src/builder/worker.ts"],
    outfile: "dist/builder.worker.js",
    platform: "node",
    format: "cjs",
  });

  if (watch) {
    await Promise.all([extension.watch(), webview.watch(), worker.watch()]);
  } else {
    await extension.rebuild();
    await webview.rebuild();
    await worker.rebuild();
    await extension.dispose();
    await webview.dispose();
    await worker.dispose();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
