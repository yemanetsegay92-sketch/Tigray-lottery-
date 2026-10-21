#!/usr/bin/env python3
"""Generate an entirely synthetic, valid ~270 KiB JPEG. No bank/customer data."""
import io, random
from PIL import Image, ImageDraw

rng = random.Random(20261021)
w, h = 900, 1400
im = Image.new("RGB", (w, h), (245, 245, 245))
pix = im.load()
for y in range(h):
    for x in range(w):
        if 80 <= x < 820 and 120 <= y < 1280:
            j = rng.randint(-22, 22)
            pix[x, y] = (max(0, min(255, 245+j)), max(0, min(255, 244+j)), max(0, min(255, 240+j)))
d = ImageDraw.Draw(im)
d.rectangle((80, 120, 820, 1280), outline=(70, 70, 70), width=3)
d.rectangle((130, 180, 770, 400), fill=(253, 253, 253))
d.text((155, 210), "TEST RECEIPT - NOT A REAL PAYMENT", fill=(20, 20, 20))
d.text((155, 280), "TIGRAY LOTTERY LOAD TEST", fill=(40, 40, 40))
d.text((155, 335), "Synthetic screenshot / no bank details", fill=(40, 40, 40))
for y in range(450, 1200, 75):
    d.line((140, y, 780, y), fill=(120, 120, 120), width=2)
for q in range(88, 40, -1):
    bio = io.BytesIO()
    im.save(bio, format="JPEG", quality=q, optimize=True)
    if 260*1024 <= bio.tell() <= 280*1024:
        with open("synthetic-receipt.jpg", "wb") as f:
            f.write(bio.getvalue())
        print("Created VALID synthetic JPEG:", bio.tell(), "bytes; quality:", q)
        break
else:
    raise RuntimeError("Could not generate JPG within expected size range")
