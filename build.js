import * as esbuild from "esbuild";

const options = {
  entryPoints: ["src/sidepanel.js", "src/options.js"],
  outdir: "extension/dist",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome116",
  sourcemap: "linked",
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  const context = await esbuild.context(options);
  await context.watch();
} else {
  await esbuild.build(options);
}
