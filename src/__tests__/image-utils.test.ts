/**
 * Tests for image utilities — encoding, validation, format detection.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

import {
  encodeImageBase64,
  isImageFile,
  imageMimeType,
  validateImage,
  isVisionCapableModel,
  buildImageContentBlock,
  MAX_IMAGE_SIZE_BYTES,
} from '../llm/image-utils';

const TMP = join(process.cwd(), 'tmp', 'synax-image-tests');

function resetTmp(): void {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
}

// Create a minimal valid 1x1 PNG (smallest valid PNG)
function createMinimalPng(): Buffer {
  // 1x1 red pixel PNG, 67 bytes
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
    'base64',
  );
  return png;
}

function createMinimalJpeg(): Buffer {
  // Minimal valid JPEG — 1x1 pixel, ~631 bytes
  // Using a known-small JPEG header pattern
  const jpeg = Buffer.from(
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYI4QmJ1kqNmJ1hqSktDVFVGVWZmdoaWpzdHV2d3h5eoWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/AOf/2Q==',
    'base64',
  );
  return jpeg;
}

describe('image-utils — format detection', () => {
  test('detects known image extensions', () => {
    expect(isImageFile('photo.png')).toBe(true);
    expect(isImageFile('photo.jpg')).toBe(true);
    expect(isImageFile('photo.jpeg')).toBe(true);
    expect(isImageFile('photo.gif')).toBe(true);
    expect(isImageFile('photo.webp')).toBe(true);
    expect(isImageFile('photo.bmp')).toBe(true);
  });

  test('detects uppercase extensions', () => {
    expect(isImageFile('photo.PNG')).toBe(true);
    expect(isImageFile('photo.JPG')).toBe(true);
  });

  test('rejects non-image files', () => {
    expect(isImageFile('code.ts')).toBe(false);
    expect(isImageFile('readme.md')).toBe(false);
    expect(isImageFile('config.toml')).toBe(false);
    expect(isImageFile('script')).toBe(false);
  });

  test('returns correct MIME types', () => {
    expect(imageMimeType('photo.png')).toBe('image/png');
    expect(imageMimeType('photo.jpg')).toBe('image/jpeg');
    expect(imageMimeType('photo.jpeg')).toBe('image/jpeg');
    expect(imageMimeType('photo.gif')).toBe('image/gif');
    expect(imageMimeType('photo.webp')).toBe('image/webp');
    expect(imageMimeType('photo.bmp')).toBe('image/bmp');
  });

  test('returns undefined MIME for non-image', () => {
    expect(imageMimeType('code.ts')).toBeUndefined();
    expect(imageMimeType('readme')).toBeUndefined();
  });
});

describe('image-utils — validation', () => {
  test('validates supported formats', () => {
    expect(validateImage('photo.png', 1000).valid).toBe(true);
    expect(validateImage('photo.jpg', 1000).valid).toBe(true);
  });

  test('rejects unsupported extensions', () => {
    const result = validateImage('code.ts', 1000);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('unsupported image format');
  });

  test('rejects empty files', () => {
    const result = validateImage('photo.png', 0);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('empty');
  });

  test('rejects files exceeding size limit', () => {
    const oversized = MAX_IMAGE_SIZE_BYTES + 1;
    const result = validateImage('photo.png', oversized);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('too large');
  });

  test('accepts files at exact size limit', () => {
    const result = validateImage('photo.png', MAX_IMAGE_SIZE_BYTES);
    expect(result.valid).toBe(true);
  });
});

describe('image-utils — base64 encoding', () => {
  beforeEach(() => resetTmp());
  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  test('encodes a valid PNG to base64 data URL', async () => {
    writeFileSync(join(TMP, 'test.png'), createMinimalPng());

    const result = await encodeImageBase64(join(TMP, 'test.png'));

    expect(result.mimeType).toBe('image/png');
    expect(result.base64).toBeTruthy();
    expect(result.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(result.sizeBytes).toBe(createMinimalPng().length);
  });

  test('encodes a valid JPEG to base64 data URL', async () => {
    writeFileSync(join(TMP, 'test.jpg'), createMinimalJpeg());

    const result = await encodeImageBase64(join(TMP, 'test.jpg'));

    expect(result.mimeType).toBe('image/jpeg');
    expect(result.dataUrl).toMatch(/^data:image\/jpeg;base64,/);
    expect(result.sizeBytes).toBeGreaterThan(0);
  });

  test('throws for unsupported file formats', async () => {
    writeFileSync(join(TMP, 'test.txt'), 'not an image');

    await expect(encodeImageBase64(join(TMP, 'test.txt'))).rejects.toThrow('unsupported image format');
  });

  test('throws for empty image files', async () => {
    writeFileSync(join(TMP, 'empty.png'), '');

    await expect(encodeImageBase64(join(TMP, 'empty.png'))).rejects.toThrow('empty');
  });

  test('throws for non-existent files', async () => {
    await expect(encodeImageBase64(join(TMP, 'missing.png'))).rejects.toThrow();
  });
});

describe('image-utils — buildImageContentBlock', () => {
  test('builds an OpenAI-compatible image content block', () => {
    const block = buildImageContentBlock('data:image/png;base64,abc123');

    expect(block).toEqual({
      type: 'image_url',
      image_url: {
        url: 'data:image/png;base64,abc123',
        detail: 'auto',
      },
    });
  });

  test('accepts detail level', () => {
    const block = buildImageContentBlock('data:image/jpeg;base64,xyz', 'high');

    expect(block.image_url.detail).toBe('high');
  });
});

describe('image-utils — isVisionCapableModel', () => {
  test('detects known vision models', () => {
    expect(isVisionCapableModel('gpt-4o')).toBe(true);
    expect(isVisionCapableModel('gpt-4-turbo')).toBe(true);
    expect(isVisionCapableModel('gpt-4-vision')).toBe(true);
    expect(isVisionCapableModel('frontier-3-opus')).toBe(true);
    expect(isVisionCapableModel('frontier-3.5-sonnet')).toBe(true);
    expect(isVisionCapableModel('gemini-2.0-flash')).toBe(true);
    expect(isVisionCapableModel('gemini-pro-vision')).toBe(true);
    expect(isVisionCapableModel('llava-v1.6')).toBe(true);
    expect(isVisionCapableModel('qwen2-vl')).toBe(true);
    expect(isVisionCapableModel('minicpm-v')).toBe(true);
    expect(isVisionCapableModel('phi-4')).toBe(true);
    expect(isVisionCapableModel('pixtral')).toBe(true);
    expect(isVisionCapableModel('cogvlm')).toBe(true);
    expect(isVisionCapableModel('internvl')).toBe(true);
  });

  test('rejects known non-vision models', () => {
    expect(isVisionCapableModel('gpt-3.5-turbo')).toBe(false);
    expect(isVisionCapableModel('llama-3-70b')).toBe(false);
    expect(isVisionCapableModel('qwen3-coder')).toBe(false);
    expect(isVisionCapableModel('codestral')).toBe(false);
    expect(isVisionCapableModel('deepseek-coder')).toBe(false);
  });

  test('handles empty/missing model', () => {
    expect(isVisionCapableModel('')).toBe(false);
  });
});
