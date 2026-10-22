// CommonJS entry for hosts that load the app with require() (e.g. Hostinger / LiteSpeed lsnode).
// The app is ESM with top-level await, which require() cannot load — import() can.
import("./src/server.js").catch((err) => {
  console.error(err);
  process.exit(1);
});
