// Client-side photo compression: any image file -> JPEG data URL, <= ~1000 px on the long side and
// under a byte budget (photos are stored in the Realtime Database as data URLs, see REBUILD_PLAN.md §3).
//
// The pure parts (fitSize, shrinkToBudget) are DOM-free and unit-tested; decoding/encoding use
// createImageBitmap + canvas and only run in a browser.

export const DEFAULTS = { maxDim: 1000, quality: 0.7, maxBytes: 400 * 1024, minQuality: 0.35, minDim: 480 };

export class ImageError extends Error {}
const NOT_IMAGE = 'That file is not a photo. Choose a JPEG, PNG or HEIC image.';
const UNREADABLE = "Couldn't read that photo. Try a different one.";

// Scale (w, h) down so the long side is at most maxDim. Never upscales; always returns integers >= 1.
export function fitSize(w, h, maxDim) {
  const long = Math.max(w, h);
  const s = long > maxDim ? maxDim / long : 1;
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

// Re-encodes until `render(maxDim, quality)` (-> data URL) fits the budget: first by lowering the JPEG
// quality in 0.1 steps down to minQuality, then by shrinking the dimensions by 20% and starting over (at most
// 3 times). Returns the last (smallest) attempt even if it is still over budget. `render` may be async.
export async function shrinkToBudget(render, { maxDim, quality, maxBytes, minQuality, minDim }) {
  let dim = maxDim;
  let out = '';
  for (let pass = 0; pass < 4; pass++) {
    for (let q = quality; ; q -= 0.1) {
      const qq = Math.max(q, minQuality);
      out = await render(dim, qq);
      if (out.length <= maxBytes) return out;
      if (qq <= minQuality) break;
    }
    const next = Math.round(dim * 0.8);
    if (next < minDim) break;
    dim = next;
  }
  return out;
}

// EXIF-correct decode: createImageBitmap honours orientation; the <img> fallback relies on the browser's
// default `image-orientation: from-image` (all current browsers).
async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bmp, width: bmp.width, height: bmp.height, release: () => bmp.close && bmp.close() };
    } catch (e) { /* e.g. options unsupported or format not decodable: try <img> */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new ImageError(UNREADABLE)); });
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

export async function compressImage(file, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  if (!file || (file.type && !file.type.startsWith('image/')) || (!file.type && !/\.(jpe?g|png|gif|webp|heic|heif|avif|bmp)$/i.test(file.name || ''))) {
    throw new ImageError(NOT_IMAGE);
  }
  const img = await decode(file);
  try {
    if (!(img.width > 0 && img.height > 0)) throw new ImageError(UNREADABLE);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const render = (maxDim, quality) => {
      const { width, height } = fitSize(img.width, img.height, maxDim);
      canvas.width = width;
      canvas.height = height;
      ctx.fillStyle = '#fff'; // JPEG has no alpha: transparent PNGs would turn black
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img.source, 0, 0, width, height);
      return canvas.toDataURL('image/jpeg', quality);
    };
    const url = await shrinkToBudget(render, opts);
    if (!url.startsWith('data:image/jpeg')) throw new ImageError(UNREADABLE);
    return url;
  } finally {
    img.release();
  }
}
