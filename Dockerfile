# Ahoy — one image: the web UI built in, the server. ludarr (the engine) runs in its own container.
# Build from the repo root:   docker build -t ahoy .

# ── stage 1: web UI → server/public ──
FROM oven/bun:1 AS web
WORKDIR /src/web
COPY web/package.json web/bun.lock* ./
RUN bun install
COPY web/ ./
RUN bun run build

# ── stage 2: runtime ──
FROM oven/bun:1
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server/package.json server/bun.lock ./
# sharp comes with its Linux build (@img/sharp-linux-x64 + libvips, in the lockfile); onnxruntime-node bundles its CPU builds for
# every platform: keep Linux's, drop the ~200 MB for Windows and macOS. Its postinstall would only fetch the CUDA providers
# (hundreds of MB from NuGet, unused: the cards run on the CPU); Bun does not run it, and ONNXRUNTIME_NODE_INSTALL=skip makes sure.
RUN ONNXRUNTIME_NODE_INSTALL=skip bun install --frozen-lockfile --production \
 && rm -rf node_modules/onnxruntime-node/bin/napi-v6/win32 node_modules/onnxruntime-node/bin/napi-v6/darwin
COPY server/src ./src
COPY --from=web /src/server/public ./public

# CARD_CUTOUTS=off: no 973 MB model download and no ~7.5 GB cut-out pass (the Home's cards are then all dissolves)
ENV PORT=8790 \
    AHOY_CONFIG=/config
VOLUME ["/config"]
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD bun -e 'fetch("http://127.0.0.1:8790/api/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
CMD ["bun", "run", "src/main.ts"]
