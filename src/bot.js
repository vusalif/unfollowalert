/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  Telegram Bot — @unfollowalert_bot
 *  ─────────────────────────────────────────────────────────────────────────────
 *  Handles user interactions: registration, setting Instagram username,
 *  manual checks, status queries, and more.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

const TelegramBot = require("node-telegram-bot-api");
const db = require("./db");
const { processUser } = require("./scheduler");

function log(msg) {
    const ts = new Date().toLocaleString("en-US", {
        dateStyle: "medium",
        timeStyle: "medium",
    });
    console.log(`[Bot][${ts}] ${msg}`);
}

// ─── Rate Limiter ────────────────────────────────────────────────────────────
// Prevent users from spamming /check
const checkCooldowns = new Map();
const COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

function isOnCooldown(telegramId) {
    const lastCheck = checkCooldowns.get(telegramId);
    if (!lastCheck) return false;
    return Date.now() - lastCheck < COOLDOWN_MS;
}

function setCooldown(telegramId) {
    checkCooldowns.set(telegramId, Date.now());
}

function getCooldownRemaining(telegramId) {
    const lastCheck = checkCooldowns.get(telegramId);
    if (!lastCheck) return 0;
    const remaining = COOLDOWN_MS - (Date.now() - lastCheck);
    return Math.max(0, Math.ceil(remaining / 1000 / 60));
}

// ─── Messages ────────────────────────────────────────────────────────────────

const WELCOME_MSG = `
👋 <b>Welcome to UnfollowAlert!</b>

I track your Instagram followers and notify you when someone unfollows you.

<b>Here's how to get started:</b>

1️⃣ Set your Instagram username:
   <code>/set yourusername</code>

2️⃣ That's it! I'll check your followers every 12 hours and notify you of any changes.

<b>Commands:</b>
/set <code>username</code> — Set your Instagram username
/status — View your tracking status
/check — Force an immediate check
/stop — Pause tracking
/start — Resume tracking
/help — Show this message

🔒 <i>Your data is private and only visible to you.</i>
`;

const HELP_MSG = `
📖 <b>UnfollowAlert Commands</b>

/set <code>username</code> — Set or change your Instagram username
/status — View your current tracking status
/check — Force an immediate follower check
/stop — Pause follower tracking
/start — Resume tracking
/help — Show this help message

<b>How it works:</b>
I check your followers every 12 hours. When someone unfollows you, I'll send you a notification with their username linked to their profile.

<b>Tips:</b>
• Make sure your Instagram account is <b>public</b> (or followable by our account) for accurate tracking
• /check has a 10-minute cooldown to prevent rate-limiting
• Use /stop to temporarily pause tracking without losing your data
`;

// ─── Bot Setup ───────────────────────────────────────────────────────────────

function createBot() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
        throw new Error("TELEGRAM_BOT_TOKEN is not set in environment variables");
    }

    const bot = new TelegramBot(token, { polling: true });

    log("✅ Telegram bot started with polling");

    // ── /start ──
    bot.onText(/\/start$/, async (msg) => {
        const { id, username, first_name } = msg.from;

        // Register/update user
        db.upsertUser(id, username, first_name);

        // Re-activate if they'd stopped
        db.setActive(id, true);

        log(`👤 User ${username || first_name || id} started the bot`);

        await bot.sendMessage(id, WELCOME_MSG, { parse_mode: "HTML" });
    });

    // ── /help ──
    bot.onText(/\/help/, async (msg) => {
        await bot.sendMessage(msg.chat.id, HELP_MSG, { parse_mode: "HTML" });
    });

    // ── /set <username> ──
    bot.onText(/\/set\s+@?([a-zA-Z0-9._]{1,30})/, async (msg, match) => {
        const telegramId = msg.from.id;
        const igUsername = match[1].toLowerCase();

        // Make sure user is registered
        db.upsertUser(telegramId, msg.from.username, msg.from.first_name);

        const prevUser = db.getUser(telegramId);
        const wasTracking = prevUser && prevUser.instagram_username;

        db.setInstagramUsername(telegramId, igUsername);
        db.setActive(telegramId, true);

        log(`📝 User ${msg.from.username || telegramId} set IG username to @${igUsername}`);

        let response =
            `✅ <b>Instagram username set!</b>\n\n` +
            `Now tracking: <a href="https://instagram.com/${igUsername}">@${igUsername}</a>\n\n`;

        if (wasTracking && prevUser.instagram_username !== igUsername) {
            response += `⚠️ Changed from @${prevUser.instagram_username}. Previous tracking data has been kept.\n\n`;
        }

        response +=
            `Your first check will run within the next scheduled cycle, or use /check to run one now.`;

        await bot.sendMessage(telegramId, response, {
            parse_mode: "HTML",
            disable_web_page_preview: true,
        });
    });

    // ── /set (no username provided) ──
    bot.onText(/^\/set\s*$/, async (msg) => {
        await bot.sendMessage(
            msg.chat.id,
            "❌ Please provide your Instagram username.\n\nUsage: <code>/set yourusername</code>",
            { parse_mode: "HTML" }
        );
    });

    // ── /status ──
    bot.onText(/\/status/, async (msg) => {
        const user = db.getUser(msg.from.id);

        if (!user || !user.instagram_username) {
            await bot.sendMessage(
                msg.chat.id,
                "You haven't set up tracking yet.\n\nUse <code>/set yourusername</code> to get started.",
                { parse_mode: "HTML" }
            );
            return;
        }

        const followers = db.getCurrentFollowers(user.id);
        const recentUnfollowers = db.getRecentUnfollowers(user.id);

        let status =
            `📊 <b>Your Tracking Status</b>\n\n` +
            `📸 Instagram: <a href="https://instagram.com/${user.instagram_username}">@${user.instagram_username}</a>\n` +
            `👥 Tracked followers: <b>${followers.length}</b>\n` +
            `${user.is_active ? "🟢" : "🔴"} Status: <b>${user.is_active ? "Active" : "Paused"}</b>\n`;

        if (user.last_checked_at) {
            status += `🕐 Last check: ${user.last_checked_at} UTC\n`;
        } else {
            status += `🕐 Last check: <i>Not yet checked</i>\n`;
        }

        if (recentUnfollowers.length > 0) {
            status += `\n🚫 <b>Recent unfollowers:</b>\n`;
            recentUnfollowers.forEach((u) => {
                status += `  • <a href="https://instagram.com/${u.follower_username}">@${u.follower_username}</a> (${u.lost_at})\n`;
            });
        }

        await bot.sendMessage(msg.chat.id, status, {
            parse_mode: "HTML",
            disable_web_page_preview: true,
        });
    });

    // ── /check ──
    bot.onText(/\/check/, async (msg) => {
        const telegramId = msg.from.id;
        const user = db.getUser(telegramId);

        if (!user || !user.instagram_username) {
            await bot.sendMessage(
                msg.chat.id,
                "You haven't set up tracking yet.\n\nUse <code>/set yourusername</code> to get started.",
                { parse_mode: "HTML" }
            );
            return;
        }

        if (!user.is_active) {
            await bot.sendMessage(
                msg.chat.id,
                "Tracking is paused. Use /start to resume.",
                { parse_mode: "HTML" }
            );
            return;
        }

        if (isOnCooldown(telegramId)) {
            const remaining = getCooldownRemaining(telegramId);
            await bot.sendMessage(
                msg.chat.id,
                `⏳ Please wait <b>${remaining} minute(s)</b> before checking again.`,
                { parse_mode: "HTML" }
            );
            return;
        }

        setCooldown(telegramId);

        await bot.sendMessage(
            msg.chat.id,
            "🔍 <b>Checking your followers now…</b>\n\nThis may take a few minutes depending on your follower count.",
            { parse_mode: "HTML" }
        );

        log(`⚡ Manual check requested by ${msg.from.username || telegramId}`);
        await processUser(user, bot);
    });

    // ── /stop ──
    bot.onText(/\/stop/, async (msg) => {
        const telegramId = msg.from.id;
        db.setActive(telegramId, false);

        log(`⏸ User ${msg.from.username || telegramId} paused tracking`);

        await bot.sendMessage(
            msg.chat.id,
            "⏸ <b>Tracking paused.</b>\n\nYour data is preserved. Use /start to resume anytime.",
            { parse_mode: "HTML" }
        );
    });

    // ── Unknown commands / general messages ──
    bot.on("message", async (msg) => {
        // Skip if it's a command we already handle
        if (msg.text && msg.text.startsWith("/")) return;

        // If user sends plain text, suggest /set
        if (msg.text) {
            const clean = msg.text.trim().replace(/^@/, "");
            if (/^[a-zA-Z0-9._]{1,30}$/.test(clean)) {
                await bot.sendMessage(
                    msg.chat.id,
                    `Did you mean to set your Instagram username?\n\nTry: <code>/set ${clean}</code>`,
                    { parse_mode: "HTML" }
                );
            }
        }
    });

    // ── Error handling ──
    bot.on("polling_error", (err) => {
        log(`❌ Polling error: ${err.message}`);
    });

    return bot;
}

module.exports = { createBot };
