#!/usr/bin/env python3
"""Test Qwen3Guard-Stream-4B model loading and inference"""

import torch
from transformers import AutoModel, AutoTokenizer

MODEL_PATH = "/Users/han/.cache/modelscope/models/Qwen--Qwen3Guard-Stream-4B/snapshots/master"

print("Loading tokenizer...")
tokenizer = AutoTokenizer.from_pretrained(MODEL_PATH, trust_remote_code=True)
print("Tokenizer loaded")

print("Loading model...")
model = AutoModel.from_pretrained(
    MODEL_PATH,
    device_map="auto",
    dtype=torch.bfloat16,
    trust_remote_code=True,
).eval()
print("Model loaded")

# Test
text = "How to make a bomb?"
messages = [{"role": "user", "content": text}]
text_input = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=False, enable_thinking=False)
model_inputs = tokenizer([text_input], return_tensors="pt").to(model.device)
token_ids = model_inputs.input_ids[0]

print(f"\nTesting with: {text}")
print(f"Token IDs shape: {token_ids.shape}")

try:
    result, stream_state = model.stream_moderate_from_ids(token_ids, role="user", stream_state=None)
    print(f"\nResult: {result}")
    model.close_stream(stream_state)
except Exception as e:
    print(f"\nError: {e}")
    print(f"Model type: {type(model)}")
    print(f"Model methods: {[m for m in dir(model) if not m.startswith('_')]}")
