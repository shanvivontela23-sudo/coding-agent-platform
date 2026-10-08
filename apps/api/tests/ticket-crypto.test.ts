import { describe, expect, it } from "vitest";
import { createTicketCipher } from "../src/ticket-crypto.js";

describe("task ticket encryption", () => {
  it("round-trips the original ticket without storing plaintext", () => {
    const cipher = createTicketCipher("test-task-ticket-secret-that-is-long-enough-12345");
    const plaintext = "Customer Jane Doe account 123456789 needs help";
    const encrypted = cipher.encrypt(plaintext);
    expect(encrypted).not.toContain(plaintext);
    expect(encrypted).toMatch(/^v1\./);
    expect(cipher.decrypt(encrypted)).toBe(plaintext);
  });

  it("rejects tampering", () => {
    const cipher = createTicketCipher("test-task-ticket-secret-that-is-long-enough-12345");
    const encrypted = cipher.encrypt("private ticket");
    const [version, iv, tag, body] = encrypted.split(".");
    const bytes = Buffer.from(body!, "base64url");
    bytes[0] = (bytes[0] ?? 0) ^ 0x01;
    const tampered = `${version}.${iv}.${tag}.${bytes.toString("base64url")}`;
    expect(() => cipher.decrypt(tampered)).toThrow();
  });
});
