"""Generate the PWA PNG icons (192, 512, maskable 512) with no dependencies."""

import math
import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")
SS = 4  # supersampling factor for antialiasing


def png_bytes(width, height, rows):
    raw = b"".join(
        b"\x00" + bytes(channel for pixel in row for channel in pixel) for row in rows
    )

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def mix(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def round_rect_coverage(u, v, inset, radius):
    """Signed-distance coverage for a rounded square inset by `inset`."""
    lo, hi = inset, 1.0 - inset
    r = radius * (1.0 - 2.0 * inset)
    cx = min(max(u, lo + r), hi - r)
    cy = min(max(v, lo + r), hi - r)
    dist = math.hypot(u - cx, v - cy)
    return 1.0 if dist <= r else 0.0


def wifi_coverage(u, v, scale):
    """Wi-Fi arcs + dot inside a unit box, scaled about the canvas centre."""
    cx, cy = 0.5, 0.635
    gu = (u - 0.5) / scale + 0.5
    gv = (v - 0.5) / scale + 0.5
    dx, dy = gu - cx, gv - cy
    dist = math.hypot(dx, dy)

    if dist <= 0.058:
        return 1.0

    if gv > cy:
        return 0.0

    theta = math.atan2(cy - gv, gu - cx)
    if not (0.52 < theta < 2.62):
        return 0.0

    for radius in (0.175, 0.272, 0.369):
        if abs(dist - radius) <= 0.026:
            return 1.0
    return 0.0


def render(size, inset, path):
    rows = []
    for y in range(size):
        row = []
        for x in range(size):
            acc = [0.0, 0.0, 0.0]
            for sy in range(SS):
                for sx in range(SS):
                    u = (x + (sx + 0.5) / SS) / size
                    v = (y + (sy + 0.5) / SS) / size

                    color = (15, 23, 42)
                    # soft emerald glow, top-left
                    glow = max(0.0, 1.0 - math.hypot(u - 0.1, v) / 0.85)
                    color = mix(color, (16, 66, 60), 0.55 * glow**2)

                    box = round_rect_coverage(u, v, inset, 0.235)
                    if box > 0:
                        t = min(1.0, max(0.0, (v - inset) / max(0.001, 1.0 - 2.0 * inset)))
                        color = mix(color, mix((16, 185, 129), (4, 120, 87), t), 0.98)

                    glyph = wifi_coverage(u, v, 1.0 - 2.0 * inset)
                    if glyph > 0 and box > 0:
                        color = mix(color, (240, 253, 244), glyph)

                    acc[0] += color[0]
                    acc[1] += color[1]
                    acc[2] += color[2]

            total = SS * SS
            row.append(
                (
                    round(acc[0] / total),
                    round(acc[1] / total),
                    round(acc[2] / total),
                    255,
                )
            )
        rows.append(row)

    with open(path, "wb") as handle:
        handle.write(png_bytes(size, size, rows))
    print(f"wrote {path}")


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    render(192, 0.0, os.path.join(OUT_DIR, "icon-192.png"))
    render(512, 0.0, os.path.join(OUT_DIR, "icon-512.png"))
    render(512, 0.115, os.path.join(OUT_DIR, "icon-maskable-512.png"))


if __name__ == "__main__":
    main()
