import { loadConfig } from "./config.mjs";
import { createRenderer } from "./render.mjs";
import { createRendererServer } from "./server.mjs";

const config = loadConfig();
const renderer = createRenderer(config);
const rendererServer = createRendererServer({
  config,
  renderer,
});

let shuttingDown = false;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

await rendererServer.start();
console.log(
  `[content-renderer] listening on http://${config.bindAddr}:${config.port}`,
);

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  console.log(`[content-renderer] received ${signal}, shutting down`);
  let exitCode = 0;
  try {
    await rendererServer.close();
  } catch (error) {
    exitCode = 1;
    console.error("[content-renderer] failed to close server", error);
  }

  try {
    await renderer.close();
  } catch (error) {
    exitCode = 1;
    console.error("[content-renderer] failed to close browser", error);
  }

  process.exit(exitCode);
}
