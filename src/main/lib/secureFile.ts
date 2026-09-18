import { safeStorage } from 'electron'

/**
 * Encrypt-at-rest via the OS keychain (DPAPI / Keychain / libsecret) with a
 * clearly-marked reversible fallback when no backend exists. The single
 * implementation for every secret file in the app.
 */
export function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

export function encryptString(plain: string): Buffer {
  return encryptionAvailable() ? safeStorage.encryptString(plain) : Buffer.from(`plain:${Buffer.from(plain, 'utf8').toString('base64')}`, 'utf8')
}

export function decryptString(buf: Buffer): string {
  if (buf.subarray(0, 6).toString('utf8') === 'plain:') return Buffer.from(buf.subarray(6).toString('utf8'), 'base64').toString('utf8')
  return safeStorage.decryptString(buf)
}
