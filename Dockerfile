# ─── Stage: Production Image ─────────────────────────────────────────────────
# Uses the official Puppeteer image which includes Chrome pre-installed
FROM ghcr.io/puppeteer/puppeteer:23.11.1

# Set working directory
WORKDIR /app

# We run as the built-in 'pptruser' (non-root) for security
# The puppeteer image already has this user set up

# Copy package files first for Docker layer caching
COPY --chown=pptruser:pptruser package.json package-lock.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Copy the rest of the application
COPY --chown=pptruser:pptruser index.js ./

# Copy data files if they exist (cookies, followers snapshot)
# These will typically be mounted as volumes in production
COPY --chown=pptruser:pptruser cookies.json ./

# Environment variables (these get overridden by .env or hosting platform)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable \
    HEADLESS=true

# The app runs as a long-lived process (node-cron scheduler)
CMD ["node", "index.js", "--run-now"]
