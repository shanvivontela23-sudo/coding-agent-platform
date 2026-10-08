import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export interface TicketCipher {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

function keyFromSecret(secret: string): Buffer {
  if (secret.length < 32) throw new Error("task ticket encryption secret must be at least 32 characters");
  return createHash("sha256").update(`dhara-task-ticket:${secret}`, "utf8").digest();
}

export function createTicketCipher(secret: string): TicketCipher {
  const key = keyFromSecret(secret);
  return {
    encrypt(plaintext) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
    },
    decrypt(ciphertext) {
      const [version, ivText, tagText, encryptedText, extra] = ciphertext.split(".");
      if (version !== "v1" || !ivText || !tagText || encryptedText === undefined || extra !== undefined) throw new Error("encrypted ticket is invalid");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64url"));
      decipher.setAuthTag(Buffer.from(tagText, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(encryptedText, "base64url")), decipher.final()]).toString("utf8");
    },
  };
}
