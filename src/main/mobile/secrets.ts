// The phone companion's own secrets in mobile.json: the home Wi-Fi mode TLS
// key and the Web Push (VAPID) private key. Encrypted with Electron
// safeStorage (DPAPI on Windows) through its asynchronous API whenever
// encryption is available. (Pairing tokens aren't here: only their SHA-256 is
// stored, see devices.ts.)
//
// Secrets saved by older versions with the synchronous API (no `v`) decrypt
// with the asynchronous one too; each is re-encrypted with it on its first
// read and saved again ("v: 2"). The stored copy is replaced only once the new
// one exists, so a failed re-encryption leaves the old one (tried again next
// time). A secret saved in plain text (encryption wasn't available then) is
// encrypted on its first read once it is.

export interface KeyBox {
  /** Encryption works now (checked once at startup). */
  available(): boolean
  encrypt(plain: string): Promise<Buffer>
  /** `shouldReEncrypt`: Windows/Electron asks for it to be encrypted again (new key). */
  decrypt(data: Buffer): Promise<{ result: string; shouldReEncrypt?: boolean }>
}

/** Encrypted with the asynchronous safeStorage API. */
export const SECRET_FORMAT = 2

export interface StoredSecret {
  /** base64 ciphertext when encrypted, else the secret itself. */
  value: string
  encrypted: boolean
  /** SECRET_FORMAT when saved by this version; missing = synchronous API (older). */
  v?: number
}

/** The secret is encrypted but encryption isn't available right now: keep it, try later. */
export class SecretUnavailableError extends Error {
  constructor() {
    super("Windows can't unlock the app's saved keys right now (encryption isn't available).")
    this.name = 'SecretUnavailableError'
  }
}

/** The secret can't be decrypted on this PC (e.g. a profile copied from another one). */
export class SecretUnreadableError extends Error {
  constructor(cause: unknown) {
    super(`The saved key can't be decrypted on this PC: ${String(cause)}`)
    this.name = 'SecretUnreadableError'
  }
}

/** Encrypt a new secret (plain text only when encryption isn't available, as before). */
export async function sealSecret(keys: KeyBox, plain: string): Promise<StoredSecret> {
  if (!keys.available()) return { value: plain, encrypted: false }
  return {
    value: (await keys.encrypt(plain)).toString('base64'),
    encrypted: true,
    v: SECRET_FORMAT
  }
}

/**
 * Read a stored secret. `resave` is its new stored form when it should be
 * saved again (older format, re-encryption asked for, or plain text while
 * encryption works now); undefined when it's fine as it is or re-encrypting
 * failed (the old copy stays).
 */
export async function openSecret(
  keys: KeyBox,
  saved: StoredSecret
): Promise<{ plain: string; resave?: StoredSecret }> {
  if (!saved.encrypted) {
    if (!keys.available()) return { plain: saved.value }
    return { plain: saved.value, resave: await reseal(keys, saved.value) }
  }
  if (!keys.available()) throw new SecretUnavailableError()
  let out: { result: string; shouldReEncrypt?: boolean }
  try {
    out = await keys.decrypt(Buffer.from(saved.value, 'base64'))
  } catch (err) {
    throw new SecretUnreadableError(err)
  }
  if (typeof out?.result !== 'string') throw new SecretUnreadableError('no result')
  const stale = saved.v !== SECRET_FORMAT || out.shouldReEncrypt === true
  return { plain: out.result, resave: stale ? await reseal(keys, out.result) : undefined }
}

async function reseal(keys: KeyBox, plain: string): Promise<StoredSecret | undefined> {
  try {
    const sealed = await sealSecret(keys, plain)
    // Only a real encryption replaces what's stored.
    return sealed.encrypted ? sealed : undefined
  } catch {
    return undefined
  }
}
