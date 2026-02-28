/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  Express Server — Landing Page & Health Check
 *  ─────────────────────────────────────────────────────────────────────────────
 *  Serves the public landing page and a /health endpoint for monitoring.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

const express = require("express");
const path = require("path");
const db = require("./db");

function log(msg) {
    const ts = new Date().toLocaleString("en-US", {
        dateStyle: "medium",
        timeStyle: "medium",
    });
    console.log(`[Server][${ts}] ${msg}`);
}

function startServer() {
    const app = express();
    const PORT = process.env.PORT || 3000;

    // Serve static files from public/
    app.use(express.static(path.join(__dirname, "..", "public")));

    // Health check endpoint
    app.get("/health", (req, res) => {
        res.json({
            status: "ok",
            uptime: process.uptime(),
            users: db.getUserCount(),
            activeUsers: db.getActiveUserCount(),
            timestamp: new Date().toISOString(),
        });
    });

    // API endpoint for landing page stats
    app.get("/api/stats", (req, res) => {
        res.json({
            totalUsers: db.getUserCount(),
            activeUsers: db.getActiveUserCount(),
        });
    });

    app.listen(PORT, () => {
        log(`🌐 Landing page live at http://localhost:${PORT}`);
    });

    return app;
}

module.exports = { startServer };
