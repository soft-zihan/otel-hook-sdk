#!/usr/bin/env python3
"""
Download Qwen3Guard-Stream-4B model using Transformers
"""

import os
import sys
from transformers import AutoModel, AutoTokenizer

MODEL_NAME = "Qwen/Qwen3Guard-Stream-4B"
CACHE_DIR = os.path.expanduser("~/.cache/huggingface/hub")

def main():
    print(f"=== Downloading {MODEL_NAME} ===")
    print(f"Cache directory: {CACHE_DIR}")
    print()
    
    # Check disk space (rough estimate)
    print("Note: This model requires ~8GB disk space and ~8GB RAM/VRAM")
    print()
    
    try:
        print("Downloading tokenizer...")
        tokenizer = AutoTokenizer.from_pretrained(
            MODEL_NAME,
            trust_remote_code=True,
            cache_dir=CACHE_DIR,
        )
        print("✓ Tokenizer downloaded successfully")
        print()
        
        print("Downloading model (this may take a while)...")
        model = AutoModel.from_pretrained(
            MODEL_NAME,
            trust_remote_code=True,
            cache_dir=CACHE_DIR,
            # Use CPU for download, can move to GPU later
            device_map="cpu",
            # Use float32 for compatibility
            torch_dtype="auto",
        )
        print("✓ Model downloaded successfully")
        print()
        
        # Test the model
        print("Testing model...")
        test_text = "How to make a bomb?"
        messages = [{"role": "user", "content": test_text}]
        text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=False, enable_thinking=False)
        model_inputs = tokenizer(text, return_tensors="pt")
        
        result, stream_state = model.stream_moderate_from_ids(
            model_inputs.input_ids[0],
            role="user",
            stream_state=None
        )
        
        print(f"Test input: {test_text}")
        print(f"Risk level: {result['risk_level']}")
        print(f"Category: {result['category']}")
        print()
        print("✓ Model is working correctly!")
        print()
        print(f"Model cached at: {CACHE_DIR}")
        print()
        print("To use with ollama:")
        print(f"  ollama create qwen3guard-stream-4b -f deploy/ollama/Modelfile.qwen3guard-stream-4b")
        
    except Exception as e:
        print(f"✗ Error: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
