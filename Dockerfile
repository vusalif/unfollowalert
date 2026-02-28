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

# Copy the application source
COPY --chown=pptruser:pptruser index.js ./
COPY --chown=pptruser:pptruser src/ ./src/
COPY --chown=pptruser:pptruser public/ ./public/

# Copy cookies (shared Instagram session)
COPY --chown=pptruser:pptruser cookies.json ./

# Create data directory for SQLite database
RUN mkdir -p /app/data

# Environment variables (overridden by hosting platform)
# Note: Chrome is bundled in the puppeteer base image at
# /home/pptruser/.cache/puppeteer/chrome/ — Puppeteer auto-detects it.
ENV HEADLESS=true \
    PORT=3000

# Expose the web server port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# The app runs as a long-lived process
CMD ["node", "index.js"]
