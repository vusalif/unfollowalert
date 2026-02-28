/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  Database Layer — SQLite via better-sqlite3
 *  ─────────────────────────────────────────────────────────────────────────────
 *  Stores user registrations and follower snapshots for multi-user tracking.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const DATA_DIR = path.join(__dirname, "..", "data");
const DB_PATH = path.join(DATA_DIR, "unfollowalert.db");

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent performance
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ─── Schema ──────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id         TEXT    UNIQUE NOT NULL,
    telegram_username   TEXT,
    telegram_first_name TEXT,
    instagram_username  TEXT,
    is_active           INTEGER DEFAULT 1,
    created_at          TEXT    DEFAULT (datetime('now')),
    last_checked_at     TEXT
  );

  CREATE TABLE IF NOT EXISTS followers (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    follower_username TEXT    NOT NULL,
    first_seen_at     TEXT    DEFAULT (datetime('now')),
    lost_at           TEXT,
    UNIQUE(user_id, follower_username, first_seen_at)
  );

  CREATE INDEX IF NOT EXISTS idx_followers_user_id ON followers(user_id);
  CREATE INDEX IF NOT EXISTS idx_followers_active  ON followers(user_id, lost_at);
  CREATE INDEX IF NOT EXISTS idx_users_active      ON users(is_active);
`);

// ─── Prepared Statements ─────────────────────────────────────────────────────

const stmts = {
    // Users
    upsertUser: db.prepare(`
    INSERT INTO users (telegram_id, telegram_username, telegram_first_name)
    VALUES (@telegram_id, @telegram_username, @telegram_first_name)
    ON CONFLICT(telegram_id) DO UPDATE SET
      telegram_username   = @telegram_username,
      telegram_first_name = @telegram_first_name
    RETURNING *
  `),

    getUser: db.prepare(`SELECT * FROM users WHERE telegram_id = ?`),

    setInstagramUsername: db.prepare(`
    UPDATE users SET instagram_username = ? WHERE telegram_id = ?
  `),

    setActive: db.prepare(`
    UPDATE users SET is_active = ? WHERE telegram_id = ?
  `),

    updateLastChecked: db.prepare(`
    UPDATE users SET last_checked_at = datetime('now') WHERE id = ?
  `),

    getActiveUsers: db.prepare(`
    SELECT * FROM users WHERE is_active = 1 AND instagram_username IS NOT NULL
  `),

    getUserCount: db.prepare(`SELECT COUNT(*) as count FROM users`),

    getActiveUserCount: db.prepare(`
    SELECT COUNT(*) as count FROM users WHERE is_active = 1 AND instagram_username IS NOT NULL
  `),

    // Followers
    getCurrentFollowers: db.prepare(`
    SELECT follower_username FROM followers
    WHERE user_id = ? AND lost_at IS NULL
  `),

    addFollower: db.prepare(`
    INSERT OR IGNORE INTO followers (user_id, follower_username)
    VALUES (?, ?)
  `),

    markLost: db.prepare(`
    UPDATE followers SET lost_at = datetime('now')
    WHERE user_id = ? AND follower_username = ? AND lost_at IS NULL
  `),

    getRecentUnfollowers: db.prepare(`
    SELECT follower_username, lost_at FROM followers
    WHERE user_id = ? AND lost_at IS NOT NULL
    ORDER BY lost_at DESC LIMIT 20
  `),
};

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Register or update a Telegram user.
 */
function upsertUser(telegramId, username, firstName) {
    return stmts.upsertUser.get({
        telegram_id: String(telegramId),
        telegram_username: username || null,
        telegram_first_name: firstName || null,
    });
}

/**
 * Get user by Telegram ID.
 */
function getUser(telegramId) {
    return stmts.getUser.get(String(telegramId));
}

/**
 * Set the Instagram username for a user.
 */
function setInstagramUsername(telegramId, igUsername) {
    stmts.setInstagramUsername.run(igUsername.toLowerCase(), String(telegramId));
}

/**
 * Activate or deactivate tracking.
 */
function setActive(telegramId, active) {
    stmts.setActive.run(active ? 1 : 0, String(telegramId));
}

/**
 * Update the last_checked_at timestamp.
 */
function updateLastChecked(userId) {
    stmts.updateLastChecked.run(userId);
}

/**
 * Get all active users with an Instagram username set.
 */
function getActiveUsers() {
    return stmts.getActiveUsers.all();
}

/**
 * Get total registered user count.
 */
function getUserCount() {
    return stmts.getUserCount.get().count;
}

/**
 * Get the count of active users being tracked.
 */
function getActiveUserCount() {
    return stmts.getActiveUserCount.get().count;
}

/**
 * Get the current follower list for a user (those not yet marked as lost).
 */
function getCurrentFollowers(userId) {
    return stmts.getCurrentFollowers.all(userId).map((r) => r.follower_username);
}

/**
 * Sync a fresh follower list for a user.
 * Marks missing users as lost, adds new ones.
 * Returns { unfollowers: string[], newFollowers: string[] }
 */
const syncFollowers = db.transaction((userId, freshList) => {
    const currentFollowers = getCurrentFollowers(userId);
    const currentSet = new Set(currentFollowers);
    const freshSet = new Set(freshList);

    const unfollowers = currentFollowers.filter((u) => !freshSet.has(u));
    const newFollowers = freshList.filter((u) => !currentSet.has(u));

    // Mark unfollowers
    for (const username of unfollowers) {
        stmts.markLost.run(userId, username);
    }

    // Add new followers
    for (const username of newFollowers) {
        stmts.addFollower.run(userId, username);
    }

    updateLastChecked(userId);

    return { unfollowers, newFollowers };
});

/**
 * Initialize followers for a first-time user (baseline snapshot).
 * Returns how many were saved.
 */
const initializeFollowers = db.transaction((userId, followers) => {
    for (const username of followers) {
        stmts.addFollower.run(userId, username);
    }
    updateLastChecked(userId);
    return followers.length;
});

/**
 * Get recent unfollowers for a user.
 */
function getRecentUnfollowers(userId) {
    return stmts.getRecentUnfollowers.all(userId);
}

/**
 * Check if this is the first check for a user (no followers stored yet).
 */
function isFirstCheck(userId) {
    return getCurrentFollowers(userId).length === 0;
}

module.exports = {
    db,
    upsertUser,
    getUser,
    setInstagramUsername,
    setActive,
    getActiveUsers,
    getUserCount,
    getActiveUserCount,
    getCurrentFollowers,
    syncFollowers,
    initializeFollowers,
    getRecentUnfollowers,
    isFirstCheck,
};
