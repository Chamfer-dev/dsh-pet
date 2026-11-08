"""Generate the default gray smiley pet sprites.

Run:  python tools/make_smiley.py

Assets (horizontal strips of 160x160 frames, transparent background):
  idle.png     2 frames: open eyes, blink
  working.png  2 frames: same face, tiny bob
  waiting.png  2 frames: same face with a small "?" bubble

The window's click-through region is computed from the alpha channel of the
IDLE frames: fully transparent pixels never block the desktop. Replace these
files with your own art (same frame size/count) or edit assets/pet.json.
"""

import json
import os

from PIL import Image, ImageDraw, ImageFont

S = 4
W = 160
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "window", "assets")

BODY = (154, 158, 164, 255)
BODY_HI = (182, 186, 192, 255)
OUTLINE = (120, 124, 130, 255)
EYE = (58, 63, 70, 255)
SHINE = (240, 242, 245, 255)
AMBER = (214, 158, 46, 255)
WHITE = (250, 250, 252, 255)

FONT_PATH = r"C:\Windows\Fonts\arialbd.ttf"


def font(size):
    try:
        return ImageFont.truetype(FONT_PATH, size)
    except OSError:
        return ImageFont.load_default()


def frame(blink=False, dy=0, question=False):
    img = Image.new("RGBA", (W * S, W * S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx, cy = 80 * S, 86 * S
    r = 58 * S
    offset = dy * S

    # body
    d.ellipse([cx - r, cy - r + offset, cx + r, cy + r + offset], fill=BODY, outline=OUTLINE, width=int(3 * S))
    # soft top highlight
    d.ellipse(
        [cx - int(38 * S), cy - int(46 * S) + offset, cx + int(6 * S), cy - int(18 * S) + offset],
        fill=BODY_HI,
    )

    # eyes
    eye_y = cy - int(8 * S) + offset
    for side in (-1, 1):
        ex = cx + side * int(20 * S)
        if blink:
            d.arc(
                [ex - int(8 * S), eye_y - int(5 * S), ex + int(8 * S), eye_y + int(5 * S)],
                start=15,
                end=165,
                fill=EYE,
                width=int(3 * S),
            )
        else:
            d.ellipse([ex - int(6 * S), eye_y - int(7 * S), ex + int(6 * S), eye_y + int(7 * S)], fill=EYE)
            d.ellipse([ex - int(2 * S), eye_y - int(5 * S), ex, eye_y - int(3 * S)], fill=SHINE)

    # smile
    mouth_y = cy + int(20 * S) + offset
    d.arc(
        [cx - int(22 * S), mouth_y - int(12 * S), cx + int(22 * S), mouth_y + int(12 * S)],
        start=20,
        end=160,
        fill=EYE,
        width=int(4 * S),
    )

    if question:
        bx = cx + int(38 * S)
        by = cy - int(64 * S) + offset
        d.ellipse([bx, by, bx + int(32 * S), by + int(32 * S)], fill=WHITE, outline=AMBER, width=int(3 * S))
        d.text((bx + int(10 * S), by + int(3 * S)), "?", font=font(int(24 * S)), fill=AMBER)

    return img.resize((W, W), Image.LANCZOS)


STATES = {
    "idle": {
        "frames": [frame(blink=False), frame(blink=True)],
        "fps": 2,
        "loop": True,
    },
    "working": {
        "frames": [frame(blink=False, dy=-1), frame(blink=True, dy=-1)],
        "fps": 3,
        "loop": True,
    },
    "waiting": {
        "frames": [frame(blink=False, question=True), frame(blink=True, question=True)],
        "fps": 2,
        "loop": True,
    },
}


def main():
    os.makedirs(OUT, exist_ok=True)
    manifest = {"frameWidth": W, "frameHeight": W, "states": {}}
    for name, spec in STATES.items():
        images = spec["frames"]
        strip = Image.new("RGBA", (W * len(images), W), (0, 0, 0, 0))
        for index, piece in enumerate(images):
            strip.paste(piece, (index * W, 0))
        strip.save(os.path.join(OUT, f"{name}.png"))
        manifest["states"][name] = {
            "image": f"{name}.png",
            "frames": len(images),
            "fps": spec["fps"],
            "loop": spec["loop"],
        }
        print(f"{name}.png  {strip.width}x{strip.height} ({len(images)} frames)")
    with open(os.path.join(OUT, "pet.json"), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
    print("pet.json written")


if __name__ == "__main__":
    main()
