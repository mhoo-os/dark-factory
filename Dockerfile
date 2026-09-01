FROM docker.io/library/node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
COPY sandbox/agent.mjs /opt/mhoo-factory-agent.mjs
