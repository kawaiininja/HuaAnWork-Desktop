# update-server container (Task 3.5): the read-only intranet release-channel
# server. Sources run directly through Node's type stripping, so there is no
# build stage and no runtime dependency to install (package.json declares none).
#
# No VOLUME and no hard-coded data directory: the deploy host provides
# <dataDir> with a bind mount and the required env variables
# (docs/update-server-deployment.md).
FROM node:22-slim AS runtime
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV NODE_ENV=production
RUN useradd --system --uid 10001 updateserver
USER updateserver
EXPOSE 8790
CMD ["node", "--experimental-strip-types", "src/index.ts"]
