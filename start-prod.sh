#!/bin/bash

# WhatsApp Message Sender - Production Start Script

echo "🚀 Starting WhatsApp Message Sender in Production Mode..."

# Check if .env file exists
if [ ! -f .env ]; then
    echo "⚠️  Warning: .env file not found. Copying from .env.example..."
    if [ -f .env.example ]; then
        cp .env.example .env
        echo "✅ .env file created. Please edit it with your configuration."
    else
        echo "❌ Error: .env.example not found. Please create a .env file manually."
        exit 1
    fi
fi

# Create necessary directories
echo "📁 Creating necessary directories..."
mkdir -p uploads bot_sessions temp public

# Start with Docker Compose
echo "🐳 Starting with Docker Compose..."
docker-compose up -d

# Show logs
echo "📋 Showing container logs..."
docker-compose logs -f audio-sender