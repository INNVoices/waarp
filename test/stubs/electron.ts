// Minimal electron stand-in for offline checks of main-process code (store only). Tests flip `secure` to model DPAPI.
export const stub = { secure: true }
export const safeStorage = {
  isEncryptionAvailable: (): boolean => stub.secure,
  encryptString: (s: string): Buffer => Buffer.from('enc:' + s, 'utf8'),
  decryptString: (b: Buffer): string => b.toString('utf8').replace(/^enc:/, ''),
}
