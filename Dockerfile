FROM docker.io/cloudflare/sandbox:0.7.0

# The approved python-tests-v1 profile runs inside the Sandbox, not on the
# Worker. Keep the Sandbox base image for Cloudflare integration and add the
# interpreter that the profile's validation commands require.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/*

COPY sandbox/agent.mjs /opt/mhoo-factory-agent.mjs
