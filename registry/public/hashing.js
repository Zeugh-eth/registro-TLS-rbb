export const SUPPORTED_HASH_ALGORITHM = 'SHA-256';

export async function hashDocument(file, algorithm = SUPPORTED_HASH_ALGORITHM) {
  if (algorithm !== SUPPORTED_HASH_ALGORITHM) throw new Error('Algoritmo de hash não suportado pelo aplicativo.');
  const bytes = await file.arrayBuffer();
  const digest = await globalThis.crypto.subtle.digest(algorithm, bytes);
  return '0x' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
