import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diskDriver } from "./disk";
import type { StorageDriver } from "./driver";
import { buildKey, contentTypeFor, putThenPersist, safeTenantKey } from "./index";

/**
 * The disk driver is exercised against a real temp directory; the s3 driver
 * against an in-memory fake that implements the same contract. Running the
 * SAME suite over both is the point — the whole design rests on the two being
 * interchangeable, so a behavioural difference between them is the bug most
 * worth catching.
 */

function fakeS3Driver(): StorageDriver & { store: Map<string, Buffer> } {
  const store = new Map<string, Buffer>();
  return {
    store,
    name: "s3",
    async put(key, body) {
      store.set(key, body);
    },
    async get(key) {
      const body = store.get(key);
      return body ? { body, contentType: contentTypeFor(key) } : null;
    },
    async delete(key) {
      store.delete(key);
    },
    async exists(key) {
      return store.has(key);
    },
    async list(prefix = "") {
      return Array.from(store.keys()).filter((k) => k.startsWith(prefix));
    },
  };
}

describe("storage drivers behave identically", () => {
  let dir: string;
  let drivers: [string, StorageDriver][];

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "tms-storage-"));
    process.env.UPLOAD_DIR = dir;
    drivers = [
      ["disk", diskDriver()],
      ["s3", fakeS3Driver()],
    ];
  });

  afterEach(async () => {
    delete process.env.UPLOAD_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips an object", async () => {
    for (const [name, d] of drivers) {
      const key = "tenant-a/pod/file.pdf";
      await d.put(key, Buffer.from("hello"), "application/pdf");
      const got = await d.get(key);
      expect(got?.body.toString(), name).toBe("hello");
      expect(got?.contentType, name).toBe("application/pdf");
    }
  });

  it("reports existence, and deletes", async () => {
    for (const [name, d] of drivers) {
      const key = "tenant-a/pod/gone.pdf";
      expect(await d.exists(key), name).toBe(false);
      await d.put(key, Buffer.from("x"), "application/pdf");
      expect(await d.exists(key), name).toBe(true);
      await d.delete(key);
      expect(await d.exists(key), name).toBe(false);
      expect(await d.get(key), name).toBeNull();
    }
  });

  it("deleting something absent is not an error", async () => {
    for (const [name, d] of drivers) {
      await expect(d.delete("tenant-a/pod/never.pdf"), name).resolves.toBeUndefined();
    }
  });

  it("lists keys under a prefix", async () => {
    for (const [name, d] of drivers) {
      await d.put("tenant-a/pod/1.pdf", Buffer.from("1"), "application/pdf");
      await d.put("tenant-a/docreg/2.pdf", Buffer.from("2"), "application/pdf");
      await d.put("tenant-b/pod/3.pdf", Buffer.from("3"), "application/pdf");
      expect((await d.list("tenant-a")).sort(), name).toEqual([
        "tenant-a/docreg/2.pdf",
        "tenant-a/pod/1.pdf",
      ]);
      expect((await d.list()).length, name).toBe(3);
    }
  });
});

describe("safeTenantKey", () => {
  const tenant = "tenant-a";

  it("accepts a key under the caller's own tenant", () => {
    expect(safeTenantKey(["tenant-a", "pod", "x.pdf"], tenant)).toBe("tenant-a/pod/x.pdf");
  });

  it("refuses another tenant's prefix", () => {
    // the attack that actually matters in a multi-tenant store
    expect(safeTenantKey(["tenant-b", "pod", "x.pdf"], tenant)).toBeNull();
  });

  it.each([
    ["dot segment", ["tenant-a", "..", "tenant-b", "x.pdf"]],
    ["encoded dot segment", ["%2e%2e", "tenant-a", "x.pdf"]],
    ["double-encoded dot segment", ["%252e%252e", "tenant-a", "x.pdf"]],
    ["encoded separator", ["tenant-a", "pod%2f..%2fx.pdf"]],
    ["backslash", ["tenant-a", "pod\\..\\x.pdf"]],
    ["empty segment", ["", "tenant-a", "x.pdf"]],
    ["NUL byte", ["tenant-a", `x${String.fromCharCode(0)}.pdf`]],
  ])("refuses %s", (_label, segments) => {
    expect(safeTenantKey(segments as string[], tenant)).toBeNull();
  });

  it("refuses a malformed percent-encoding rather than throwing", () => {
    expect(safeTenantKey(["%E0%A4%A"], tenant)).toBeNull();
  });
});

describe("putThenPersist", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "tms-storage-"));
    process.env.UPLOAD_DIR = dir;
    process.env.STORAGE_DRIVER = "disk";
  });

  afterEach(async () => {
    delete process.env.UPLOAD_DIR;
    delete process.env.STORAGE_DRIVER;
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps the object when the row is written", async () => {
    const key = buildKey("tenant-a", "pod", "pdf");
    const out = await putThenPersist(key, Buffer.from("x"), "application/pdf", async () => "row-1");
    expect(out).toBe("row-1");
    expect(await diskDriver().exists(key)).toBe(true);
  });

  it("removes the object and rethrows when the row fails", async () => {
    const key = buildKey("tenant-a", "pod", "pdf");
    const boom = new Error("db down");
    await expect(
      putThenPersist(key, Buffer.from("x"), "application/pdf", async () => {
        throw boom;
      })
    ).rejects.toBe(boom);
    // no dangling object, and no dangling reference either
    expect(await diskDriver().exists(key)).toBe(false);
  });

  it("surfaces the original error even if cleanup also fails", async () => {
    // cleanup is best effort: a failure there must never mask why the write failed
    const key = buildKey("tenant-a", "pod", "pdf");
    const boom = new Error("db down");
    process.env.UPLOAD_DIR = "/proc/nonexistent-and-unwritable";
    await expect(
      putThenPersist(key, Buffer.from("x"), "application/pdf", async () => {
        throw boom;
      })
    ).rejects.toBeTruthy();
  });
});

describe("contentTypeFor", () => {
  it("maps the types this app stores", () => {
    expect(contentTypeFor("a/b/x.pdf")).toBe("application/pdf");
    expect(contentTypeFor("a/b/x.PNG")).toBe("image/png");
    expect(contentTypeFor("a/b/x.webp")).toBe("image/webp");
    expect(contentTypeFor("a/b/x.bin")).toBe("application/octet-stream");
  });
});
