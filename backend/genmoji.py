from diffusers import StableDiffusionPipeline
import torch
from PIL import Image
import sys
import time

# ✅ Parse CLI arg
prompt = sys.argv[1] if len(sys.argv) > 1 else "happy local foodie cartoon emoji"
filename = f"genmoji_{int(time.time())}.png"

# ✅ Load pipeline on GPU
pipe = StableDiffusionPipeline.from_pretrained(
    "stabilityai/stable-diffusion-2-1",
    torch_dtype=torch.float16
).to("cuda")

# ✅ Generate image
image = pipe(prompt).images[0]
image.save(filename)

# ✅ Print filename so Node can read it
print(filename)
