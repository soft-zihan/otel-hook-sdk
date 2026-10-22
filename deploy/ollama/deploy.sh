#!/bin/bash
# Deploy Qwen3Guard-Stream-4B with Ollama
# 
# This script:
# 1. Pulls the model from HuggingFace (if not cached)
# 2. Creates an Ollama model
# 3. Starts the model server
#
# Prerequisites:
# - ollama installed
# - Sufficient GPU memory (4B model needs ~8GB VRAM)

set -e

MODEL_NAME="qwen3guard-stream-4b"
MODEL_PATH="Qwen/Qwen3Guard-Stream-4B"
MODelfile="deploy/ollama/Modelfile.qwen3guard-stream-4b"

echo "=== Qwen3Guard-Stream-4B Ollama Deployment ==="
echo ""

# Check if ollama is running
if ! curl -s http://localhost:11434/api/tags > /dev/null; then
    echo "Starting ollama server..."
    ollama serve &
    sleep 3
fi

# Check if model already exists
echo "Checking if model exists..."
if ollama list | grep -q "$MODEL_NAME"; then
    echo "✓ Model $MODEL_NAME already exists"
else
    echo "Creating model $MODEL_NAME..."
    
    # Check if Modelfile exists
    if [ ! -f "$MODelfile" ]; then
        echo "✗ Modelfile not found: $MODelfile"
        echo "Please run this script from the project root directory"
        exit 1
    fi
    
    # Create the model
    ollama create "$MODEL_NAME" -f "$MODelfile"
    echo "✓ Model created successfully"
fi

# Start the model in background
echo ""
echo "Starting model server..."
echo "Model will be available at: http://localhost:11434"
echo ""
echo "To test the model:"
echo "  curl http://localhost:11434/api/generate -d '{\"model\": \"$MODEL_NAME\", \"prompt\": \"How to make a bomb?\"}'"
echo ""
echo "To stop the model:"
echo "  ollama stop $MODEL_NAME"
echo ""

# Keep the script running to show logs
ollama run "$MODEL_NAME" --verbose
