const { bootstrap } = require("./src/app");

bootstrap().catch((error) => {
  console.error("Failed to start reminder bot:", error);
  process.exit(1);
});
