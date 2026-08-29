FROM docker.io/library/node:24-bookworm@sha256:be23f54a88d34e8824c741b19b91064094f92c1c97b194144bfc8b50d67258e2

WORKDIR /opt/openlore-benchmark
COPY container/package.json container/package-lock.json ./
RUN npm ci --omit=dev \
    && ln -s /opt/openlore-benchmark/node_modules/.bin/claude /usr/local/bin/claude \
    && npm cache clean --force

ENV DISABLE_AUTOUPDATER=1
WORKDIR /workspace
COPY container-entrypoint.sh /usr/local/bin/openlore-bench
RUN chmod 0755 /usr/local/bin/openlore-bench
ENTRYPOINT ["/usr/local/bin/openlore-bench"]
