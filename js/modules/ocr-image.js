// A screenshot, made easier for Tesseract to read (Timers → Import from screenshot).
// Measured 2026-09-30 on 60-line schedules with every minute 00-59 (scratch benchmark):
//   as-is, 1x Discord crop:             51-52/60 times right, 3-9 SILENTLY WRONG (9 read as 0, PM as AM)
//   2x + grayscale, dark turned light:  60/60 on both layouts, 0 wrong, and the fastest correct variant
//   a phone-resolution screenshot:      already 60/60 at 1x; 4x made it worse
// So: scale up to 2x, but within a pixel budget (big screenshots already have big text; iOS Safari
// also refuses canvases over ~16.7 M pixels), then grayscale, inverted when the image is dark.

const MAX_SCALE = 2;
const PIXEL_BUDGET = 12e6;

// File/Blob -> canvas for worker.recognize()
export async function ocrCanvas(file) {
    const bmp = await createImageBitmap(file);
    const scale = Math.max(1, Math.min(MAX_SCALE, Math.sqrt(PIXEL_BUDGET / (bmp.width * bmp.height))));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();

    const img = ctx.getImageData(0, 0, c.width, c.height), px = img.data;
    const lum = (i) => 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    let sum = 0;
    for (let i = 0; i < px.length; i += 4) sum += lum(i);
    const dark = sum / (px.length / 4) < 128;   // Discord dark theme: light text on dark -> dark on light
    for (let i = 0; i < px.length; i += 4) {
        const g = dark ? 255 - lum(i) : lum(i);
        px[i] = px[i + 1] = px[i + 2] = g;
    }
    ctx.putImageData(img, 0, 0);
    return c;
}
