/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  Scheduler — Automated Follower Checks
 *  ─────────────────────────────────────────────────────────────────────────────
 *  Runs periodic checks for all active users, staggering requests to avoid
 *  rate-limiting. Sends results via Telegram.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

const cron = require("node-cron");
const db = require("./db");
const { scrapeFollowers } = require("./scraper");

// ─── Utilities ───────────────────────────────────────────────────────────────

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(msg) {
    const ts = new Date().toLocaleString("en-US", {
        dateStyle: "medium",
        timeStyle: "medium",
    });
    console.log(`[Scheduler][${ts}] ${msg}`);
}

function randomBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ─── Build Report Message ────────────────────────────────────────────────────

function buildReport(unfollowers, newFollowers, totalFollowers) {
    let msg = `📊 <b>Follower Report</b>\n`;
    msg += `👥 Current followers: <b>${totalFollowers}</b>\n\n`;

    if (unfollowers.length > 0) {
        msg += `🚫 <b>Unfollowed you (${unfollowers.length}):</b>\n`;
        unfollowers.forEach((u) => {
            msg += `  • <a href="https://instagram.com/${u}">@${u}</a>\n`;
        });
        msg += `\n`;
    } else {
        msg += `✅ No one unfollowed you since the last check.\n\n`;
    }

    if (newFollowers.length > 0) {
        msg += `🆕 <b>New followers (${newFollowers.length}):</b>\n`;
        newFollowers.forEach((u) => {
            msg += `  • <a href="https://instagram.com/${u}">@${u}</a>\n`;
        });
    }

    return msg;
}

// ─── Process a Single User ───────────────────────────────────────────────────

async function processUser(user, bot) {
    const { id, telegram_id, instagram_username } = user;

    log(`🔍 Checking @${instagram_username} for user ${telegram_id}…`);

    const MAX_RETRIES = 2;

    for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
        try {
            const freshFollowers = await scrapeFollowers(instagram_username);

            if (freshFollowers.length === 0) {
                log(`⚠️  No followers scraped for @${instagram_username}. Skipping.`);
                await bot.sendMessage(
                    telegram_id,
                    "⚠️ <b>Check Failed</b>\n\nCouldn't scrape your follower list right now. " +
                    "This might be a temporary issue. We'll try again on the next scheduled check.",
                    { parse_mode: "HTML" }
                );
                return;
            }

            const isFirst = db.isFirstCheck(id);

            if (isFirst) {
                // First-time baseline
                const count = db.initializeFollowers(id, freshFollowers);
                await bot.sendMessage(
                    telegram_id,
                    `🎉 <b>First Check Complete!</b>\n\n` +
                    `Saved <b>${count}</b> followers as your baseline.\n` +
                    `You'll be notified of any changes on the next check (every 12 hours).`,
                    { parse_mode: "HTML" }
                );
                log(`🎉 Baseline saved for @${instagram_username}: ${count} followers`);
            } else {
                // Compare with existing snapshot
                const { unfollowers, newFollowers } = db.syncFollowers(id, freshFollowers);

                log(
                    `📊 @${instagram_username}: ${unfollowers.length} unfollowed, ${newFollowers.length} new`
                );

                // SAFETY GUARD: If we lost > 10% of followers AND more than 5 in one go, 
                // it's likely a partial/failed scrape. Don't sync to DB to avoid "fake" unfollower alerts.
                const previousCount = db.getCurrentFollowers(id).length;
                const dropCount = unfollowers.length;
                if (dropCount > 5 && dropCount > previousCount * 0.1) {
                    log(`🛑 Abnormal follower drop detected (${dropCount}/${previousCount}). Suspecting partial scrape. Skipping sync.`);
                    await bot.sendMessage(
                        telegram_id,
                        `⚠️ <b>Unusual Activity Detected</b>\n\nOur check showed you lost <b>${dropCount}</b> followers at once. Since this is a large drop, we've paused this update to prevent a false report. We'll verify this on the next check.`,
                        { parse_mode: "HTML" }
                    );
                    return;
                }

                // Only send message if there are changes
                if (unfollowers.length > 0 || newFollowers.length > 0) {
                    const report = buildReport(unfollowers, newFollowers, freshFollowers.length);
                    await bot.sendMessage(telegram_id, report, {
                        parse_mode: "HTML",
                        disable_web_page_preview: true,
                    });
                }
            }

            return; // Success — exit the retry loop

        } catch (err) {
            const isTimeout = err.message.includes("timed out") || err.message.includes("Timeout");

            if (isTimeout && attempt <= MAX_RETRIES) {
                log(`⏳ Attempt ${attempt} timed out for @${instagram_username}. Retrying in 30s…`);
                await sleep(30_000); // Let memory free up before retrying
                continue;
            }

            log(`❌ Error processing @${instagram_username}: ${err.message}`);
            try {
                await bot.sendMessage(
                    telegram_id,
                    `⚠️ <b>Check Error</b>\n\n<code>${err.message}</code>\n\nWe'll retry on the next scheduled check.`,
                    { parse_mode: "HTML" }
                );
            } catch (sendErr) {
                log(`❌ Couldn't notify user ${telegram_id}: ${sendErr.message}`);
            }
            return;
        }
    }
}

// ─── Run All Checks ──────────────────────────────────────────────────────────

let isRunning = false;

async function runAllChecks(bot) {
    if (isRunning) {
        log("⏳ A check cycle is already running. Skipping.");
        return;
    }

    isRunning = true;
    const users = db.getActiveUsers();

    log(`═══════════════════════════════════════════════════`);
    log(`🔄 Starting scheduled check for ${users.length} active user(s)…`);
    log(`═══════════════════════════════════════════════════`);

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        await processUser(user, bot);

        // Stagger between users (2-5 minutes) to avoid rate-limiting
        if (i < users.length - 1) {
            const delay = randomBetween(120000, 300000); // 2-5 min
            log(`⏳ Waiting ${Math.round(delay / 1000)}s before next user…`);
            await sleep(delay);
        }
    }

    log(`═══════════════════════════════════════════════════`);
    log(`✅ All checks complete.`);
    log(`═══════════════════════════════════════════════════\n`);
    isRunning = false;
}

// ─── Start Cron ──────────────────────────────────────────────────────────────

function startScheduler(bot) {
    const schedule = process.env.CRON_SCHEDULE || "0 */12 * * *";

    log(`⏰ Scheduling follower checks: "${schedule}"`);

    cron.schedule(schedule, async () => {
        log("⏰ Cron triggered — starting scheduled checks…");
        await runAllChecks(bot);
    });
}

module.exports = { startScheduler, runAllChecks, processUser };
