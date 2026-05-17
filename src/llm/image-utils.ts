/**
 * Image utilities for vision-model support.
 *
 * Handles: image format detection, base64 encoding with correct MIME type,
 * size validation, and building OpenAI-compatible image content blocks.
 */

import { readFile } from 'fs/promises';
import { extname } from 'path';

// ─── Constants ───────────────────────────────────────────────────────────────

/** File extensions recognized as images by Synax. */
export const SUPPORTED_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
]);

/** Maximum image size in bytes (20 MB). */
export const MAX_IMAGE_SIZE_BYTES = 20 * 1024 * 1024;

/** MIME type lookup by extension. */
const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

// ─── Types ───────────────────────────────────────────────────────────────────

export interface EncodedImage {
  /** MIME type (e.g. "image/png"). */
  mimeType: string;
  /** Raw base64 string (without data URL prefix). */
  base64: string;
  /** Full data URL (e.g. "data:image/png;base64,iVBOR..."). */
  dataUrl: string;
  /** File size in bytes. */
  sizeBytes: number;
}

export interface ImageValidationResult {
  valid: boolean;
  reason?: string;
}

export interface ImageContentBlock {
  type: 'image_url';
  image_url: {
    url: string;
    detail?: 'auto' | 'low' | 'high';
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Check whether a file path has a recognized image extension.
 */
export function isImageFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return SUPPORTED_IMAGE_EXTENSIONS.has(ext);
}

/**
 * Resolve the MIME type for an image file path.
 * Returns undefined if the extension is not recognized.
 */
export function imageMimeType(filePath: string): string | undefined {
  const ext = extname(filePath).toLowerCase();
  return MIME_TYPES[ext];
}

/**
 * Validate an image file before encoding.
 *
 * Checks:
 * - Extension is supported
 * - File exists (handled by caller)
 * - Size is within MAX_IMAGE_SIZE_BYTES
 */
export function validateImage(filePath: string, sizeBytes: number): ImageValidationResult {
  const ext = extname(filePath).toLowerCase();

  if (!SUPPORTED_IMAGE_EXTENSIONS.has(ext)) {
    return {
      valid: false,
      reason: `unsupported image format: ${ext || '(no extension)'}. Supported: ${[...SUPPORTED_IMAGE_EXTENSIONS].join(', ')}`,
    };
  }

  if (sizeBytes <= 0) {
    return { valid: false, reason: 'image file is empty' };
  }

  if (sizeBytes > MAX_IMAGE_SIZE_BYTES) {
    const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(1);
    const maxMB = (MAX_IMAGE_SIZE_BYTES / (1024 * 1024)).toFixed(0);
    return {
      valid: false,
      reason: `image too large: ${sizeMB}MB exceeds ${maxMB}MB limit`,
    };
  }

  return { valid: true };
}

/**
 * Read an image file from disk and encode it as base64 with the correct MIME type.
 *
 * Returns the encoded image with data URL ready for OpenAI vision format.
 * Throws on filesystem errors or validation failures.
 */
export async function encodeImageBase64(filePath: string): Promise<EncodedImage> {
  const ext = extname(filePath).toLowerCase();
  const mimeType = MIME_TYPES[ext];

  if (!mimeType) {
    throw new Error(`unsupported image format: ${ext || '(no extension)'}`);
  }

  const buffer = await readFile(filePath);
  const sizeBytes = buffer.length;

  const validation = validateImage(filePath, sizeBytes);
  if (!validation.valid) {
    throw new Error(validation.reason);
  }

  const base64 = buffer.toString('base64');
  const dataUrl = `data:${mimeType};base64,${base64}`;

  return { mimeType, base64, dataUrl, sizeBytes };
}

/**
 * Build an OpenAI-compatible image content block from a data URL.
 *
 * The `detail` field follows the OpenAI vision API spec:
 * - "auto" (default): the model decides
 * - "low": 512px low-res
 * - "high": high-res with detail crops
 */
export function buildImageContentBlock(dataUrl: string, detail: 'auto' | 'low' | 'high' = 'auto'): ImageContentBlock {
  return {
    type: 'image_url',
    image_url: { url: dataUrl, detail },
  };
}

// ─── Vision model detection ──────────────────────────────────────────────────

/**
 * Guess whether a model is likely vision-capable based on its model ID string.
 *
 * This is a heuristic that checks for well-known vision model name patterns.
 * Providers that don't match any known pattern will get a warning when
 * image content is sent.
 */
export function isVisionCapableModel(modelId: string): boolean {
  if (!modelId) return false;

  const lower = modelId.toLowerCase();

  // Known vision-capable model patterns
  const patterns = [
    // OpenAI
    /\bgpt-4o\b/,
    /\bgpt-4[\s-]*turbo\b/,
    /\bgpt-4-vision\b/,
    /\bgpt-4\.1\b/,
    /\bgpt-4-1106\b/,
    /\bgpt-4-0125\b/,
    /\bgpt-5\b/,
    /\bo1\b/,
    /\bo3\b/,
    /\bo4-mini\b/,
    // Anthropic
    /\bfrontier[\s-]*3\b/,
    /\bfrontier[\s-]*3[.\s-]*5\b/,
    /\bfrontier[\s-]*4\b/,
    // Google
    /\bgemini.*(?:flash|pro|vision|2)/,
    /\bgemma[\s-]*3\b/,
    // Open-source multimodal
    /\bllava\b/,
    /\bbakllava\b/,
    /\bcogvlm\b/,
    /\bfuyu\b/,
    /\bidefics\b/,
    /\bpixtral\b/,
    /\bpaligemma\b/,
    /\bqwen.*vl\b/,
    /\bqwen2.*vl\b/,
    /\bminicpm.*v\b/,
    /\bphi.*vision\b/,
    /\bphi-4\b/,
    /\binternvl\b/,
    /\binternlm.*vision\b/,
    // Vision label
    /\bvision\b/,
    /\bmultimodal\b/,
  ];

  return patterns.some((pattern) => pattern.test(lower));
}
