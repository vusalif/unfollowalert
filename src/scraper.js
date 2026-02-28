/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  Instagram Follower Scraper
 *  ─────────────────────────────────────────────────────────────────────────────
 *  Uses Puppeteer with stealth plugin and shared Instagram cookies to scrape
 *  follower lists for any public or accessible profile.
 *
 *  The browser instance is reused across multiple checks to save resources.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

puppeteer.use(StealthPlugin());

const COOKIES_PATH = path.join(__dirname, "..", "cookies.json");

const SCROLL_CONFIG = {
    minDelay: 2000,
    maxDelay: 5000,
    scrollStep: 400,
    maxStalledAttempts: 8,
};

// ─── Utilities ───────────────────────────────────────────────────────────────

function randomDelay(min = SCROLL_CONFIG.minDelay, max = SCROLL_CONFIG.maxDelay) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(msg) {
    const ts = new Date().toLocaleString("en-US", {
        dateStyle: "medium",
        timeStyle: "medium",
    });
    console.log(`[Scraper][${ts}] ${msg}`);
}

// ─── Cookie Management ──────────────────────────────────────────────────────

function loadCookies() {
    if (!fs.existsSync(COOKIES_PATH)) {
        throw new Error(`cookies.json not found at ${COOKIES_PATH}`);
    }
    const raw = fs.readFileSync(COOKIES_PATH, "utf-8");
    const cookies = JSON.parse(raw);

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

// ─── Scrollable Container Detection ─────────────────────────────────────────

async function findScrollableContainer(page) {
    return page.evaluateHandle(() => {
        const dialog = document.querySelector('div[role="dialog"]');
        if (!dialog) return null;

        const knownClass = dialog.querySelector("div._aano");
        if (knownClass && knownClass.scrollHeight > knownClass.clientHeight) {
            return knownClass;
        }

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

        for (const div of allDivs) {
            if (div.scrollHeight > div.clientHeight + 50 && div.scrollHeight > bestScrollHeight) {
                bestCandidate = div;
                bestScrollHeight = div.scrollHeight;
            }
        }

        return bestCandidate || dialog;
    });
}

// ─── Follower Extraction ─────────────────────────────────────────────────────

async function extractFollowerUsernames(page) {
    return page.evaluate(() => {
        const dialog = document.querySelector('div[role="dialog"]');
        if (!dialog) return [];

        const usernames = new Set();

        const links = dialog.querySelectorAll("a");
        for (const link of links) {
            const href = link.getAttribute("href");
            if (!href) continue;
            const match = href.match(/^\/([a-zA-Z0-9._]{1,30})\/$/);
            if (
                match &&
                !href.includes("/explore/") &&
                !href.includes("/accounts/") &&
                !href.includes("/p/") &&
                !href.includes("/reel/")
            ) {
                if (match[1].length > 0) {
                    usernames.add(match[1]);
                }
            }
        }

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

// ─── Main Scrape Function ────────────────────────────────────────────────────

/**
 * Scrape the follower list for a given Instagram username.
 * @param {string} instagramUsername
 * @returns {Promise<string[]>} Array of follower usernames, or empty on failure.
 */
async function scrapeFollowers(instagramUsername) {
    log(`🚀 Scraping followers for @${instagramUsername}…`);

    const browser = await puppeteer.launch({
        headless: "new",
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        protocolTimeout: 300_000, // 5 min — prevents Runtime.callFunctionOn timeout
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-blink-features=AutomationControlled",
            "--disable-gpu",
            "--disable-dev-shm-usage",
            "--window-size=1280,900",
            // ── Safe memory savers ──
            "--disable-extensions",
            "--disable-default-apps",
            "--disable-translate",
            "--disable-sync",
            "--no-first-run",
        ],
        defaultViewport: { width: 1280, height: 900 },
    });

    let followers = [];

    try {
        const page = await browser.newPage();
        page.setDefaultTimeout(120_000);           // 2 min for selectors / evaluate
        page.setDefaultNavigationTimeout(120_000); // 2 min for goto / navigation

        await page.setUserAgent(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        );

        log("🍪 Loading Instagram session cookies…");
        const cookies = loadCookies();
        await page.setCookie(...cookies);

        const profileUrl = `https://www.instagram.com/${instagramUsername}/`;
        log(`🌐 Navigating to ${profileUrl}`);
        await page.goto(profileUrl, { waitUntil: "networkidle2", timeout: 60000 });
        await sleep(randomDelay(3000, 5000));

        // Check if logged in
        const isLoggedIn = await page.evaluate(() => {
            return !document.querySelector('input[name="username"]');
        });

        if (!isLoggedIn) {
            throw new Error("Instagram session expired. Please update cookies.json.");
        }

        log("✅ Session is active");

        // Click followers link
        const followersLinkSelector = `a[href="/${instagramUsername}/followers/"]`;
        await page.waitForSelector(followersLinkSelector, { timeout: 15000 });
        await sleep(randomDelay(1000, 2000));
        await page.click(followersLinkSelector);
        log("✅ Clicked the Followers link");

        // Wait for dialog
        await page.waitForSelector('div[role="dialog"]', { timeout: 15000 });
        log("📋 Followers dialog opened");
        await sleep(randomDelay(3000, 5000));

        // Find scrollable container
        const scrollableHandle = await findScrollableContainer(page);
        if (!scrollableHandle) {
            throw new Error("Could not find scrollable follower list container.");
        }

        // Scroll and collect
        log("📜 Scrolling through followers…");
        let stalledCount = 0;
        let previousCount = 0;
        let scrollIteration = 0;

        while (stalledCount < SCROLL_CONFIG.maxStalledAttempts) {
            scrollIteration++;
            const currentFollowers = await extractFollowerUsernames(page);
            const mergedSet = new Set([...followers, ...currentFollowers]);
            followers = Array.from(mergedSet);

            if (scrollIteration % 5 === 0) {
                log(`   [Scroll #${scrollIteration}] ${followers.length} followers collected…`);
            }

            if (followers.length === previousCount) {
                stalledCount++;
            } else {
                stalledCount = 0;
            }
            previousCount = followers.length;

            await page.evaluate((el, step) => {
                if (el) el.scrollTop += step;
            }, scrollableHandle, SCROLL_CONFIG.scrollStep);

            await sleep(randomDelay());
        }

        // Final extraction
        const finalFollowers = await extractFollowerUsernames(page);
        followers = Array.from(new Set([...followers, ...finalFollowers]));

        log(`✅ Scraped ${followers.length} followers for @${instagramUsername}`);
    } catch (err) {
        console.error(`❌ Scraping error for @${instagramUsername}:`, err.message);
        throw err;
    } finally {
        await browser.close();
    }

    return followers;
}

module.exports = { scrapeFollowers };
