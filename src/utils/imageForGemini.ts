import sharp from 'sharp';

export function parseMaxPx(envVal: string | undefined, fallback: number): number {
    const n = parseInt(envVal ?? '', 10);
    return n > 0 ? n : fallback;
}

/** Gemini 2.0/2.5: one 768×768 tile when both sides ≤768. */
export function geminiTileCount(width: number, height: number): number {
    const tile = 768;
    return Math.ceil(width / tile) * Math.ceil(height / tile);
}

// ponytail: uniform maxPx may miss tiny receipt text — raise GEMINI_IMAGE_MAX_PX if OCR degrades
export async function resizeForGemini(
    buffer: Buffer,
    mimeType: string,
    maxPx = 768
): Promise<{ data: string; mimeType: string }> {
    if (!mimeType.startsWith('image/')) {
        return { data: buffer.toString('base64'), mimeType };
    }

    const resized = await sharp(buffer)
        .rotate()
        .resize({ width: maxPx, height: maxPx, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();

    const meta = await sharp(resized).metadata();
    const w = meta.width ?? maxPx;
    const h = meta.height ?? maxPx;
    if (geminiTileCount(w, h) > 1) {
        console.warn(`imageForGemini: ${w}x${h} exceeds 1 tile at maxPx=${maxPx}`);
    }

    return { data: resized.toString('base64'), mimeType: 'image/jpeg' };
}

async function selfCheck() {
    const cases: [number, number, number][] = [
        [768, 768, 1],
        [576, 768, 1],
        [3000, 4000, 24],
        [769, 768, 2],
    ];
    for (const [w, h, expected] of cases) {
        const got = geminiTileCount(w, h);
        if (got !== expected) {
            throw new Error(`geminiTileCount(${w},${h}) = ${got}, expected ${expected}`);
        }
    }

    const src = await sharp({
        create: { width: 2000, height: 1500, channels: 3, background: { r: 128, g: 64, b: 32 } },
    })
        .jpeg()
        .toBuffer();

    const { mimeType, data } = await resizeForGemini(src, 'image/jpeg', 768);
    if (mimeType !== 'image/jpeg') throw new Error('expected image/jpeg output');
    const out = await sharp(Buffer.from(data, 'base64')).metadata();
    const ow = out.width ?? 0;
    const oh = out.height ?? 0;
    if (Math.max(ow, oh) > 768) throw new Error(`resize exceeded max: ${ow}x${oh}`);
    if (geminiTileCount(ow, oh) !== 1) throw new Error(`resize should be 1 tile, got ${ow}x${oh}`);

    const pdf = await resizeForGemini(Buffer.from('not-an-image'), 'application/pdf');
    if (pdf.mimeType !== 'application/pdf') throw new Error('pdf passthrough failed');

    console.log('imageForGemini self-check ok');
}

if (require.main === module) {
    selfCheck().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
