# Lab container that stands in for ct105-ai on this laptop.
# Runs the Layer 1/2/3 attack/restore scripts with the right assumptions:
# - hostname ct105-ai (every hostname gate passes)
# - /opt/chain-of-custody mounted (default paths work)
# - docker socket mounted (bank_reader.py and compose work)
# - root user (install-wrappers.sh, demo-account scripts work)
# - same witness/backend ports as ct105

FROM python:3.12-bookworm
RUN apt-get update && apt-get install -y \
    bash curl coreutils jq git openssh-client \
    && rm -rf /var/lib/apt/lists/*

# Copy docker CLI and compose plugin from the official docker image.
COPY --from=docker:cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker:cli /usr/local/libexec/docker/cli-plugins /usr/local/libexec/docker/cli-plugins

# IBM Bob Shell for the defender (deploy/local/bob/defender.mjs): Bob runs here so its shell is the
# bank server itself, not the Windows host. Pinned to the version tested on the laptop.
COPY --from=node:24-bookworm-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:24-bookworm-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && npm install -g @ibm/bob@2.1.0 && npm cache clean --force

WORKDIR /opt/chain-of-custody
ENTRYPOINT ["/bin/bash"]
