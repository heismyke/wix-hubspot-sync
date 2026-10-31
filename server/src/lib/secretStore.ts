import { config } from '../config.js';
import { decrypt, encrypt } from './crypto.js';

/**
 * Where OAuth tokens live. The default implementation is envelope-style encryption at rest
 * (AES-256-GCM, key held only in the server environment), so the database alone never
 * reveals a token. Swapping in GCP Secret Manager / AWS Secrets Manager means implementing
 * this interface and storing the secret's resource name instead of the ciphertext.
 */
export interface SecretStore {
  seal(plaintext: string): Promise<string>;
  open(sealed: string): Promise<string>;
}

class LocalEncryptedSecretStore implements SecretStore {
  constructor(private readonly key: Buffer) {}
  async seal(plaintext: string) {
    return encrypt(plaintext, this.key);
  }
  async open(sealed: string) {
    return decrypt(sealed, this.key);
  }
}

export const masterKey = Buffer.from(config.TOKEN_ENCRYPTION_KEY, 'base64');
export const secretStore: SecretStore = new LocalEncryptedSecretStore(masterKey);
