#!/usr/bin/env python3
"""Deterministically generate a synthetic ~264 KB valid JPEG for cloud load tests.

Contains no bank or customer data. All test records are explicitly labeled.
"""
import io
import random
from PIL import Image, ImageDraw

width = height = 720
rng = random.Random(20261021)
image = Image.frombytes("RGB", (width, height), rng.randbytes(width * height * 3))
draw = ImageDraw.Draw(image)
draw.rectangle((25, 25, width - 25, 145), fill=(250, 250, 250))
draw.text((36, 45), "TIGRAY LOTTERY - SYNTHETIC TEST RECEIPT", fill=(20, 20, 20))
draw.text((36, 82), "NOT A REAL PAYMENT / NO BANK DETAILS", fill=(20, 20, 20))

# Choose a quality producing 260-280 KiB. Do not guess a fixed JPEG quality
# because compression can vary slightly across Pillow versions.
target_min = 260 * 1024
target_max = 280 * 1024
best = None
for quality in range(1, 96):
    buf = io.BytesIO()
    image.save(buf, format="JPEG", quality=quality, optimize=True)
    payload = buf.getvalue()
    if target_min <= len(payload) <= target_max:
        best = (quality, payload)
        break

if best is None:
    raise RuntimeError("JPEG size target not achievable (check Pillow version)")

quality, payload = best
assert payload[:3] == b"\xff\xd8\xff"
with open("synthetic-receipt.jpg", "wb") as output:
    output.write(payload)
print(f"Created synthetic JPEG: {len(payload)} bytes, quality {quality}")
