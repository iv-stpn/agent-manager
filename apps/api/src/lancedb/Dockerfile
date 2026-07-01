FROM oven/bun:1 AS base
WORKDIR /app

# Cache the HuggingFace model inside the image so container startup doesn't
# re-download it on every cold start.
ENV HF_HOME=/app/.hf

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile 2>/dev/null || bun install

COPY index.ts ./src/index.ts

# Pre-download the embedding model at build time.
RUN bun -e "import {pipeline} from '@xenova/transformers'; await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2'); console.log('model cached')"

EXPOSE 3200

CMD ["bun", "run", "src/index.ts"]
