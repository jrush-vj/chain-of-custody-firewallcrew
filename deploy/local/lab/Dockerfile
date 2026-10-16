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

WORKDIR /opt/chain-of-custody
ENTRYPOINT ["/bin/bash"]
