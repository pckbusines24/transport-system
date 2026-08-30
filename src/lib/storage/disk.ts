import { mkdir, readFile, readdir, rm, stat } from "fs/promises";
import path from "path";
import type { StorageDriver, StoredObject } from "./driver";
import { contentTypeFor } from "./index";

/**
 * Files under UPLOAD_DIR — the app's original behaviour, kept so that
 * development needs no bucket and so the cutover has something to roll back to.
 */
export function diskDriver(): StorageDriver {
  const root = () =>
    path.resolve(process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads"));

  // Callers pass keys that safeTenantKey() has already validated, but a driver
  // should not depend on its caller for its own safety: resolve, then confirm
  // the result is still inside the root before touching the filesystem.
  const abs = (key: string): string | null => {
    const r = root();
    const p = path.resolve(r, key);
    return p === r || p.startsWith(r + path.sep) ? p : null;
  };

  return {
    name: "disk",

    async put(key, body) {
      const p = abs(key);
      if (!p) throw new Error("refusing to write outside the upload root");
      await mkdir(path.dirname(p), { recursive: true });
      const { writeFile } = await import("fs/promises");
      await writeFile(p, body);
    },

    async get(key): Promise<StoredObject | null> {
      const p = abs(key);
      if (!p) return null;
      try {
        return { body: await readFile(p), contentType: contentTypeFor(key) };
      } catch {
        return null;
      }
    },

    async delete(key) {
      const p = abs(key);
      if (!p) return;
      await rm(p, { force: true });
    },

    async exists(key) {
      const p = abs(key);
      if (!p) return false;
      try {
        return (await stat(p)).isFile();
      } catch {
        return false;
      }
    },

    async list(prefix = "") {
      const r = root();
      const start = abs(prefix) ?? r;
      const out: string[] = [];
      const walk = async (dir: string): Promise<void> => {
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          return; // a missing directory is an empty one
        }
        for (const e of entries) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) await walk(p);
          else if (e.isFile()) out.push(path.relative(r, p).split(path.sep).join("/"));
        }
      };
      await walk(start);
      return out;
    },
  };
}
