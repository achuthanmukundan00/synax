import { basename, extname } from 'path';

const SECRET_FILE_BASENAMES = new Set(['.synax.toml', 'id_rsa', 'id_ed25519']);
const SECRET_FILE_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.crt']);

export function shouldSkipSecretFile(filePath: string): boolean {
  const name = basename(filePath);
  return (
    name === '.env' ||
    name.startsWith('.env.') ||
    SECRET_FILE_BASENAMES.has(name) ||
    SECRET_FILE_EXTENSIONS.has(extname(name).toLowerCase())
  );
}

export function redactSecrets(text: string): string {
  return text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]');
}
