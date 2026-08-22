# The image Glama builds to run security checks and to offer a one-click
# install. It is deliberately boring: this package has ZERO dependencies, so
# there is no install step to cache, no lockfile to honour and no build to run.
# Copying src is the whole of it.
#
# Debian rather than Alpine: the difference costs nothing here, and a glibc base
# is the one that behaves when someone later adds a native dependency.
FROM node:22-slim

# Never run the server as root. The process talks to a control plane with the
# caller's own credential and needs no privilege of its own.
USER node
WORKDIR /app

COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

# stdio is the transport. REACHPAD_ENDPOINT and REACHPAD_IDENTITY_CREDENTIAL
# are supplied by the caller at run time; see the table in README.md.
ENTRYPOINT ["node", "src/server.js"]
