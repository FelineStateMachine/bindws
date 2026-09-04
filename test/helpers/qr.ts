// Reading a QR symbol back with jsQR, a decoder that shares nothing with
// the encoder, so it proves a phone can read it.
import jsQR from "jsqr";

// scan rasterizes a module grid and reads it.
export function scan(size: number, dark: (x: number, y: number) => boolean): string | undefined {
  const px = 4, margin = 4, n = size + margin * 2, w = n * px;
  const img = new Uint8ClampedArray(w * w * 4).fill(255);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!dark(x, y)) continue;
      for (let dy = 0; dy < px; dy++) for (let dx = 0; dx < px; dx++) {
        const i = (((y + margin) * px + dy) * w + (x + margin) * px + dx) * 4;
        img[i] = img[i + 1] = img[i + 2] = 0;
      }
    }
  }
  return jsQR(img, w, w)?.data;
}
