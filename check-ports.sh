#!/bin/bash

echo "🔧 Checking Port Configuration"
echo "==============================="
echo ""

# Check if apps/server/.env exists
if [ ! -f "apps/server/.env" ]; then
    echo "❌ apps/server/.env not found!"
    echo "   Creating from .env.example..."
    cp .env.example apps/server/.env
    echo "✅ Created apps/server/.env"
    echo ""
    echo "⚠️  Please edit apps/server/.env and set your ANTHROPIC_API_KEY"
    echo "   nano apps/server/.env"
    exit 1
fi

# Check PORT setting
PORT=$(grep -E "^PORT=" apps/server/.env | cut -d= -f2)
if [ "$PORT" != "3010" ]; then
    echo "❌ PORT is set to $PORT (should be 3010)"
    echo "   Fixing..."
    sed -i '' 's/^PORT=.*/PORT=3010/' apps/server/.env
    echo "✅ Updated PORT to 3010"
else
    echo "✅ PORT correctly set to 3010"
fi

# Check ANTHROPIC_API_KEY
if ! grep -q "^ANTHROPIC_API_KEY=sk-ant-" apps/server/.env; then
    echo "⚠️  ANTHROPIC_API_KEY not set or invalid"
    echo "   Please edit apps/server/.env and add your API key"
    echo "   Current value:"
    grep "^ANTHROPIC_API_KEY=" apps/server/.env || echo "   (not set)"
fi

# Check web .env
if [ ! -f "apps/web/.env" ]; then
    echo ""
    echo "Creating apps/web/.env..."
    echo "NEXT_PUBLIC_API_URL=http://localhost:3010" > apps/web/.env
    echo "✅ Created apps/web/.env"
else
    API_URL=$(grep -E "^NEXT_PUBLIC_API_URL=" apps/web/.env 2>/dev/null | cut -d= -f2)
    if [ "$API_URL" != "http://localhost:3010" ]; then
        echo ""
        echo "❌ Web API URL is $API_URL (should be http://localhost:3010)"
        echo "   Fixing..."
        echo "NEXT_PUBLIC_API_URL=http://localhost:3010" > apps/web/.env
        echo "✅ Updated web API URL"
    else
        echo "✅ Web API URL correctly set"
    fi
fi

echo ""
echo "==============================="
echo "✅ Port configuration verified!"
echo ""
echo "Start commands:"
echo "  bun run server    # Backend on port 3010"
echo "  bun run web       # Dashboard on port 3011"
echo ""
echo "Access URLs:"
echo "  http://localhost:3010/health    # API health check"
echo "  http://localhost:3011           # Web dashboard"
