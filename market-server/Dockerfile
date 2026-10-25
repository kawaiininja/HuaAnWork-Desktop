# market-server container (Task 3.5 / spec §11). Same shape as
# update-server/Dockerfile: non-root, sources only, no VOLUME, no hard-coded
# data directory (the deploy host bind-mounts <dataDir> and supplies env).
#
# This image ships the server's own code. market-server also imports TWO
# workspace packages at runtime: `dsh-community-market/contracts` (needs `ajv`
# and its built lib/), and `@huaanwork/catalog-signing` (exports raw
# src/index.ts, so a derived image must carry a COMPILED JS copy - Node refuses
# type stripping under node_modules). The deployment supplies that closure at
# /app/node_modules, or runs from the mounted workspace instead - see the
# 〈Dockerfile 与容器运行〉 section of docs/market-server-deployment.md.
FROM node:22-slim AS runtime
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV NODE_ENV=production
RUN useradd --system --uid 10002 marketserver
USER marketserver
EXPOSE 8787
CMD ["node", "--experimental-strip-types", "src/index.ts"]
