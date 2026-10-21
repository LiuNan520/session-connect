import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { MAX_ICON_BYTES, type IconMime } from '#shared';
import { ApiError } from './errors.js';
import { MIME_EXT } from './validation.js';

export async function validateImage(bytes: Buffer, mime: string) {
  if (!Object.hasOwn(MIME_EXT, mime)) throw new ApiError(415, 'UNSUPPORTED_TYPE', '只支持 PNG、JPG、WebP、SVG 图片');
  if (bytes.length > MAX_ICON_BYTES) throw new ApiError(413, 'TOO_LARGE', '图片不能超过 1 MB');
  try {
    if (mime === 'image/svg+xml') {
      const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        .replace(/^\uFEFF/, '').replace(/^\s*(?:<\?xml[\s\S]*?\?>\s*)?(?:(?:<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)\s*)*/i, '');
      if (!/^<svg(?:\s|>)/.test(source)) throw new Error('根元素不是 svg');
    }
    const image = sharp(bytes, { failOn: 'warning', animated: true });
    const metadata = await image.metadata();
    const expected = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp', 'image/svg+xml': 'svg' }[mime];
    if (metadata.format !== expected) throw new Error('文件头与声明类型不一致');
    // metadata 只读文件头；raw 强制解码所有像素/帧，捕获截断和渲染错误。
    await image.raw().toBuffer();
  } catch { throw new ApiError(422, 'UNREADABLE', '图片读不出来，请换一张'); }
  return { mime: mime as IconMime, ext: MIME_EXT[mime as IconMime], hash: createHash('sha256').update(bytes).digest('hex') };
}
