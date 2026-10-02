# Runs the real site: the request handler, the built files, and nothing else.
#
# Deliberately NOT a plain nginx serving public/. The whole point of this site is
# that it negotiates a format from the Accept header and sets its own headers,
# and both of those live in src/index.ts. A static file server would preview the
# words but not the behaviour.
#
# The same image serves a local `docker compose up` and production, which builds
# it with LAUNCH_CHECK=1.
# Node 26 to match the API, whose image runs TypeScript directly the same way.
FROM node:26-bookworm-slim

WORKDIR /app

# No npm install: the site has no dependencies, so there is no layer to cache.
COPY build.mjs serve.mjs package.json ./
COPY src ./src
COPY content ./content
# Both load-bearing: the build copies the logo SVGs and self-hosted font out of
# assets/, and the copy guard reads reference/approved-copy.md. Without either,
# `node build.mjs` fails inside the image.
COPY assets ./assets
COPY reference ./reference
COPY scripts/launch-check.mjs ./scripts/launch-check.mjs

# Generate public/ at image build time. Fails the build loudly if any copy is
# missing or the markdown uses something the converter does not support.
RUN node build.mjs

# The launch gate. Off for a local image, where placeholders are the normal
# state; on for the production one, where a placeholder in the built site fails
# the image before anything can serve it.
ARG LAUNCH_CHECK=0
RUN if [ "$LAUNCH_CHECK" = "1" ]; then node scripts/launch-check.mjs; fi

# The server reads nothing it did not build and writes nothing at all.
USER node

# Every address inside the container, or nothing outside it can reach the server:
# :: is both address families, since Node on Linux serves IPv4 on it too, so a
# private network that reaches the container over IPv6 finds it as well.
ENV HOST=:: PORT=8787
EXPOSE 8787

CMD ["node", "serve.mjs"]
