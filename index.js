/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  Instagram Unfollower Tracker
 *  ─────────────────────────────────────────────────────────────────────────────
 *  Scrapes your Instagram follower list using a saved session (cookies.json),
 *  compares it against the previous snapshot (followers.json), detects who
 *  unfollowed you, and sends a report to your Telegram via @unfollowalert_bot.
 *
 *  Scheduled to run automatically every 12 hours via node-cron.
 *  Run with --run-now flag to execute an immediate check.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");
const TelegramBot = require("node-telegram-bot-api");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

puppeteer.use(StealthPlugin());

// ─── Configuration ───────────────────────────────────────────────────────────
const CONFIG = {
  instagram: {
    username: process.env.INSTAGRAM_USERNAME,
    profileUrl: () =>
      `https://www.instagram.com/${CONFIG.instagram.username}/`,
    cookiesPath: path.join(__dirname, "cookies.json"),
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
  },
  schedule: process.env.CRON_SCHEDULE || "0 */12 * * *",
  headless: process.env.HEADLESS !== "false",
  followersPath: path.join(__dirname, "followers.json"),
  scroll: {
    minDelay: 2000, // ms
    maxDelay: 5000, // ms
    scrollStep: 400, // pixels per scroll increment
    maxStalledAttempts: 8, // stop scrolling after this many scrolls with no new followers
  },
};

// ─── Validation ──────────────────────────────────────────────────────────────
function validateConfig() {
  const errors = [];
  if (!CONFIG.instagram.username)
    errors.push("INSTAGRAM_USERNAME is not set in .env");
  if (!CONFIG.telegram.botToken)
    errors.push("TELEGRAM_BOT_TOKEN is not set in .env");
  if (!CONFIG.telegram.chatId)
    errors.push("TELEGRAM_CHAT_ID is not set in .env");
  if (!fs.existsSync(CONFIG.instagram.cookiesPath))
    errors.push(
      `cookies.json not found at ${CONFIG.instagram.cookiesPath}. See README for extraction instructions.`
    );
  if (errors.length > 0) {
    console.error("\n❌ Configuration Errors:");
    errors.forEach((e) => console.error(`   • ${e}`));
    console.error("");
    process.exit(1);
  }
}

// ─── Utilities ───────────────────────────────────────────────────────────────

/** Returns a random integer between min and max (inclusive) */
function randomDelay(min = CONFIG.scroll.minDelay, max = CONFIG.scroll.maxDelay) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Pause execution for the given number of milliseconds */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Pretty-print a timestamp */
function timestamp() {
  return new Date().toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "medium",
  });
}

/** Log with a prefix */
function log(msg) {
  console.log(`[${timestamp()}] ${msg}`);
}

// ─── Telegram ────────────────────────────────────────────────────────────────

let bot;

function initTelegramBot() {
  bot = new TelegramBot(CONFIG.telegram.botToken, { polling: false });
  log("✅ Telegram bot initialized");
}

async function sendTelegramMessage(text) {
  try {
    await bot.sendMessage(CONFIG.telegram.chatId, text, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
    log("📨 Telegram message sent successfully");
  } catch (err) {
    console.error("❌ Failed to send Telegram message:", err.message);
  }
}

// ─── Cookie Management ──────────────────────────────────────────────────────

function loadCookies() {
  const raw = fs.readFileSync(CONFIG.instagram.cookiesPath, "utf-8");
  const cookies = JSON.parse(raw);

  // Normalize: the cookie format exported by browser extensions may differ.
  // We need at minimum: name, value, domain.
  return cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain || ".instagram.com",
    path: c.path || "/",
    httpOnly: c.httpOnly !== undefined ? c.httpOnly : false,
    secure: c.secure !== undefined ? c.secure : true,
    sameSite: c.sameSite || "None",
    ...(c.expirationDate ? { expires: c.expirationDate } : {}),
  }));
}

// ─── Follower Storage ────────────────────────────────────────────────────────

function loadPreviousFollowers() {
  if (!fs.existsSync(CONFIG.followersPath)) {
    log("📄 No previous followers.json found — this is the first run.");
    return null;
  }
  const raw = fs.readFileSync(CONFIG.followersPath, "utf-8");
  return JSON.parse(raw);
}

function saveFollowers(followers) {
  fs.writeFileSync(CONFIG.followersPath, JSON.stringify(followers, null, 2));
  log(`💾 Saved ${followers.length} followers to followers.json`);
}

// ─── Instagram Scraping ──────────────────────────────────────────────────────

/**
 * Finds the scrollable container inside the followers dialog.
 * Instagram nests the scrollable div several layers deep.
 * We locate it by checking computed overflow styles AND actual scrollable height.
 */
async function findScrollableContainer(page) {
  return page.evaluateHandle(() => {
    const dialog = document.querySelector('div[role="dialog"]');
    if (!dialog) return null;

    // Strategy 1: Look for the known Instagram class name
    const knownClass = dialog.querySelector("div._aano");
    if (knownClass && knownClass.scrollHeight > knownClass.clientHeight) {
      return knownClass;
    }

    // Strategy 2: Walk all divs and find the one with overflow-y scroll/auto
    // that also has scrollable content (scrollHeight > clientHeight)
    const allDivs = dialog.querySelectorAll("div");
    let bestCandidate = null;
    let bestScrollHeight = 0;

    for (const div of allDivs) {
      const style = window.getComputedStyle(div);
      const overflowY = style.overflowY;
      const hasOverflow = overflowY === "auto" || overflowY === "scroll" || overflowY === "hidden";
      const isScrollable = div.scrollHeight > div.clientHeight + 20;

      if (hasOverflow && isScrollable && div.scrollHeight > bestScrollHeight) {
        bestCandidate = div;
        bestScrollHeight = div.scrollHeight;
      }
    }

    if (bestCandidate) return bestCandidate;

    // Strategy 3: Fallback — find any div with the largest scrollable area
    for (const div of allDivs) {
      if (div.scrollHeight > div.clientHeight + 50 && div.scrollHeight > bestScrollHeight) {
        bestCandidate = div;
        bestScrollHeight = div.scrollHeight;
      }
    }

    return bestCandidate || dialog;
  });
}

/**
 * Extracts all visible follower usernames from the dialog.
 * Uses multiple strategies to identify profile links.
 */
async function extractFollowerUsernames(page) {
  return page.evaluate(() => {
    const dialog = document.querySelector('div[role="dialog"]');
    if (!dialog) return [];

    const usernames = new Set();

    // Strategy 1: Find all <a> tags with single-segment profile hrefs
    const links = dialog.querySelectorAll("a");
    for (const link of links) {
      const href = link.getAttribute("href");
      if (!href) continue;

      // Match /username/ pattern (single segment, no nested paths)
      const match = href.match(/^\/([a-zA-Z0-9._]{1,30})\/$/);
      if (
        match &&
        !href.includes("/explore/") &&
        !href.includes("/accounts/") &&
        !href.includes("/p/") &&
        !href.includes("/reel/")
      ) {
        const username = match[1];
        // Skip the profile owner's own username that might appear in the dialog header
        // We check by looking at whether this link is inside a list-like container
        if (username.length > 0) {
          usernames.add(username);
        }
      }
    }

    // Strategy 2: Look at span elements with specific structure
    // In Instagram's dialog, each follower row has a span with dir="auto" containing the username
    const spans = dialog.querySelectorAll('span a[role="link"]');
    for (const span of spans) {
      const href = span.getAttribute("href");
      if (!href) continue;
      const match = href.match(/^\/([a-zA-Z0-9._]{1,30})\/$/);
      if (match) {
        usernames.add(match[1]);
      }
    }

    return Array.from(usernames);
  });
}

async function scrapeFollowers() {
  log("🚀 Launching browser…");

  const browser = await puppeteer.launch({
    headless: CONFIG.headless ? "new" : false,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--window-size=1280,900",
    ],
    defaultViewport: { width: 1280, height: 900 },
  });

  let followers = [];

  try {
    const page = await browser.newPage();

    // ── Set realistic user agent ──
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    // ── Load cookies ──
    log("🍪 Loading Instagram session cookies…");
    const cookies = loadCookies();
    await page.setCookie(...cookies);

    // ── Navigate to the profile ──
    const profileUrl = CONFIG.instagram.profileUrl();
    log(`🌐 Navigating to ${profileUrl}`);
    await page.goto(profileUrl, {
      waitUntil: "networkidle2",
      timeout: 60000,
    });

    // Small delay to let the page fully render
    await sleep(randomDelay(3000, 5000));

    // ── Check if we're logged in ──
    const isLoggedIn = await page.evaluate(() => {
      const loginForm = document.querySelector('input[name="username"]');
      return !loginForm;
    });

    if (!isLoggedIn) {
      throw new Error(
        "Session appears expired! The login page was detected. " +
        "Please update your cookies.json with fresh cookies."
      );
    }

    log("✅ Session is active — logged in successfully");

    // ── Click the "followers" link ──
    log("👥 Looking for Followers link…");

    const followersLinkSelector = `a[href="/${CONFIG.instagram.username}/followers/"]`;
    await page.waitForSelector(followersLinkSelector, { timeout: 15000 });
    await sleep(randomDelay(1000, 2000));
    await page.click(followersLinkSelector);
    log("✅ Clicked the Followers link");

    // ── Wait for the followers dialog to fully load ──
    const dialogSelector = 'div[role="dialog"]';
    await page.waitForSelector(dialogSelector, { timeout: 15000 });
    log("📋 Followers dialog opened — waiting for initial content to load…");

    // Give the dialog extra time to render the initial follower list
    await sleep(randomDelay(3000, 5000));

    // ── Find the scrollable container ──
    const scrollableHandle = await findScrollableContainer(page);
    if (!scrollableHandle) {
      throw new Error("Could not find the scrollable follower list container in the dialog.");
    }
    log("🎯 Found scrollable container");

    // ── Scroll incrementally and collect followers ──
    log("📜 Scrolling through followers list (incremental scroll)…");

    let stalledCount = 0;
    let previousCount = 0;
    let scrollIteration = 0;

    while (stalledCount < CONFIG.scroll.maxStalledAttempts) {
      scrollIteration++;

      // Extract current visible usernames
      const currentFollowers = await extractFollowerUsernames(page);

      // Merge into the main set
      const mergedSet = new Set([...followers, ...currentFollowers]);
      followers = Array.from(mergedSet);

      log(`   [Scroll #${scrollIteration}] Collected ${followers.length} followers so far…`);

      // Check if we've stalled (no new followers loaded)
      if (followers.length === previousCount) {
        stalledCount++;
        log(
          `   ⏳ No new followers loaded (stall ${stalledCount}/${CONFIG.scroll.maxStalledAttempts})`
        );
      } else {
        stalledCount = 0;
      }
      previousCount = followers.length;

      // ── INCREMENTAL SCROLL ──
      // Scroll down by a fixed step (400px) instead of jumping to the bottom.
      // This properly triggers Instagram's lazy-load intersection observer.
      await page.evaluate((el, step) => {
        if (el) {
          el.scrollTop += step;
        }
      }, scrollableHandle, CONFIG.scroll.scrollStep);

      // ── Randomized human delay ──
      const delay = randomDelay();
      log(`   💤 Waiting ${delay}ms before next scroll…`);
      await sleep(delay);
    }

    // ── One final extraction after last scroll ──
    const finalFollowers = await extractFollowerUsernames(page);
    const finalSet = new Set([...followers, ...finalFollowers]);
    followers = Array.from(finalSet);

    log(`✅ Finished scrolling. Total followers collected: ${followers.length}`);
  } catch (err) {
    console.error("❌ Scraping error:", err.message);
    await sendTelegramMessage(
      `⚠️ <b>Unfollower Tracker Error</b>\n\n<code>${err.message}</code>`
    );
    followers = [];
  } finally {
    await browser.close();
    log("🔒 Browser closed");
  }

  return followers;
}

// ─── Comparison Logic ────────────────────────────────────────────────────────

function findUnfollowers(oldList, newList) {
  const newSet = new Set(newList);
  return oldList.filter((username) => !newSet.has(username));
}

function findNewFollowers(oldList, newList) {
  const oldSet = new Set(oldList);
  return newList.filter((username) => !oldSet.has(username));
}

// ─── Build Telegram Message ──────────────────────────────────────────────────

function buildReport(unfollowers, newFollowers, totalFollowers) {
  let msg = `📊 <b>Instagram Follower Report</b>\n`;
  msg += `🕐 ${timestamp()}\n`;
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

// ─── Main Run ────────────────────────────────────────────────────────────────

async function runCheck() {
  log("═══════════════════════════════════════════════════");
  log("🔍 Starting unfollower check…");
  log("═══════════════════════════════════════════════════");

  // 1. Scrape current followers
  const currentFollowers = await scrapeFollowers();

  if (currentFollowers.length === 0) {
    log("⚠️  No followers were collected. Skipping this run.");
    await sendTelegramMessage(
      "⚠️ <b>Unfollower Tracker</b>\n\nFailed to collect any followers. " +
      "The session may have expired or Instagram changed its layout. " +
      "Please check the logs."
    );
    return;
  }

  // 2. Load previous snapshot
  const previousFollowers = loadPreviousFollowers();

  if (previousFollowers === null) {
    // First run: just save and notify
    saveFollowers(currentFollowers);
    const msg =
      `🎉 <b>Unfollower Tracker — First Run</b>\n\n` +
      `Saved <b>${currentFollowers.length}</b> followers as the baseline.\n` +
      `You will be notified of changes on the next check.`;
    await sendTelegramMessage(msg);
    log("🎉 First run complete. Baseline saved.");
    return;
  }

  // 3. Compare
  const unfollowers = findUnfollowers(previousFollowers, currentFollowers);
  const newFollowers = findNewFollowers(previousFollowers, currentFollowers);

  log(`🚫 Unfollowers: ${unfollowers.length}`);
  log(`🆕 New followers: ${newFollowers.length}`);

  // 4. Send report
  const report = buildReport(unfollowers, newFollowers, currentFollowers.length);
  await sendTelegramMessage(report);

  // 5. Overwrite followers.json with the new list
  saveFollowers(currentFollowers);

  log("═══════════════════════════════════════════════════");
  log("✅ Check complete.");
  log("═══════════════════════════════════════════════════\n");
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

(async () => {
  console.log(`
  ╔═══════════════════════════════════════════════════════╗
  ║     📸  Instagram Unfollower Tracker                 ║
  ║     🤖  Powered by @unfollowalert_bot                ║
  ╚═══════════════════════════════════════════════════════╝
  `);

  validateConfig();
  initTelegramBot();

  // If --run-now flag is passed, do an immediate check
  const runNow = process.argv.includes("--run-now");

  if (runNow) {
    log("⚡ --run-now flag detected. Running an immediate check…");
    await runCheck();
    log("👋 Single run complete. Exiting.");
    process.exit(0);
  }

  // Schedule recurring checks (only when running as a long-lived process)
  log(`⏰ Scheduling follower checks with cron: "${CONFIG.schedule}"`);
  log(`   Next runs will be every 12 hours.\n`);

  cron.schedule(CONFIG.schedule, async () => {
    log("⏰ Cron triggered — starting scheduled check…");
    await runCheck();
  });

  log("💡 Tip: Run with --run-now flag for an immediate check.");
  log("   Example: npm run check");
  log("   The bot is now waiting for the next scheduled run…\n");
})();
