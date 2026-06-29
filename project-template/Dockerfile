FROM popwers/mini-bun:v1.3.14 AS base
WORKDIR /app

# install git + dependencies
RUN apk add --no-cache git ca-certificates bash

# Root workspace manifest for bun to resolve workspace:* deps
COPY package.json ./package.json

# Workspace packages
COPY packages/db/package.json ./packages/db/package.json
COPY packages/db/src ./packages/db/src
COPY packages/utils/package.json ./packages/utils/package.json
COPY packages/utils/src ./packages/utils/src
COPY packages/projects/package.json ./packages/projects/package.json
COPY packages/projects/src ./packages/projects/src

# Project server
COPY project-template/package.json ./project-template/package.json
COPY project-template/src ./project-template/src

# Install dependencies from the workspace root
RUN bun install

WORKDIR /app/project-template

# Expose port
EXPOSE 3010

# Run
CMD ["bun", "run", "src/index.ts"]
