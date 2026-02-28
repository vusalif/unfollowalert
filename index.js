/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UnfollowAlert — Entry Point
 *  ─────────────────────────────────────────────────────────────────────────────
 *  Starts the Telegram bot, scheduler, and web server.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

require("dotenv").config();

const { createBot } = require("./src/bot");
const { startScheduler } = require("./src/scheduler");
const { startServer } = require("./src/server");

function log(msg) {
  const ts = new Date().toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "medium",
  });
  console.log(`[Main][${ts}] ${msg}`);
}

(async () => {
  console.log(`
  ╔═══════════════════════════════════════════════════════╗
  ║     📸  UnfollowAlert                                ║
  ║     🤖  Instagram Unfollower Tracker                 ║
  ║     ─────────────────────────────────────────         ║
  ║     Multi-user Telegram Bot                          ║
  ╚═══════════════════════════════════════════════════════╝
  `);

  // Validate required env vars
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.error("❌ TELEGRAM_BOT_TOKEN is not set. Exiting.");
    process.exit(1);
  }

  // 1. Start the Telegram bot (with polling)
  log("🤖 Starting Telegram bot…");
  const bot = createBot();

  // 2. Start the scheduler (passes bot instance for sending messages)
  log("⏰ Starting scheduler…");
  startScheduler(bot);

  // 3. Start the web server (landing page + health check)
  log("🌐 Starting web server…");
  startServer();

  log("🚀 UnfollowAlert is fully operational!\n");

  // Graceful shutdown
  const shutdown = async (signal) => {
    log(`\n🛑 Received ${signal}. Shutting down…`);
    try {
      await bot.stopPolling();
    } catch (_) { }
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
})();
