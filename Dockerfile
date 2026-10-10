# Small official Node image; works on Oracle Ampere (ARM64) and x86.
FROM node:22-slim
# Run in production mode.
ENV NODE_ENV=production DATA_DIR=/data
# App folder.
WORKDIR /app
# Install only runtime dependencies, exactly as locked.
COPY package.json package-lock.json ./
# No dev tools, no scripts from dependencies.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
# Application code and source list.
COPY src ./src
COPY config ./config
# Private data folder owned by the unprivileged "node" user.
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
# Never run as root.
USER node
# RSS server port.
EXPOSE 8080
# Liveness probe on the read-only health endpoint.
HEALTHCHECK --interval=5m --timeout=10s CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Start the bot (hide the node:sqlite experimental warning).
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.js"]
