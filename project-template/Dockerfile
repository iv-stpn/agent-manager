FROM popwers/mini-bun:v1.3.14 AS base
WORKDIR /app

# install git + dependencies
RUN apk add --no-cache git ca-certificates bash

# Copy server package manifest and source (db is inlined under src/)
COPY package.json ./package.json
COPY src ./src

# Install dependencies
RUN bun install

# Expose port
EXPOSE 3010

# Run
CMD ["bun", "run", "src/index.ts"]
