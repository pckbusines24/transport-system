import type {
  DeleteObjectCommandInput,
  GetObjectCommandInput,
  HeadObjectCommandInput,
  ListObjectsV2CommandInput,
  PutObjectCommandInput,
  S3Client,
} from "@aws-sdk/client-s3";
import type { StorageDriver, StoredObject } from "./driver";
import { contentTypeFor } from "./index";

/**
 * Any S3-compatible object store.
 *
 * Written against the S3 API rather than a vendor SDK so the same code serves
 * Cloudflare R2, AWS S3, DigitalOcean Spaces and MinIO. R2 is the intended
 * production target — 10 GB free and, more importantly, no egress charge,
 * which matters because every file read is proxied through the app rather
 * than served from a public URL.
 *
 * Configuration:
 *   S3_BUCKET              required
 *   S3_ENDPOINT            required for R2/Spaces/MinIO; omit for AWS S3
 *   S3_REGION              "auto" for R2; a real region for AWS
 *   S3_ACCESS_KEY_ID       omit on AWS to use the instance/role credentials
 *   S3_SECRET_ACCESS_KEY
 */

let client: S3Client | null = null;
let mod: typeof import("@aws-sdk/client-s3") | null = null;

async function sdk() {
  if (!mod) mod = await import("@aws-sdk/client-s3");
  if (!client) {
    const accessKeyId = process.env.S3_ACCESS_KEY_ID;
    const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
    client = new mod.S3Client({
      region: process.env.S3_REGION || "auto",
      ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT } : {}),
      // R2 and MinIO address buckets by path, not by subdomain; harmless on AWS
      forcePathStyle: Boolean(process.env.S3_ENDPOINT),
      // fall through to the default provider chain when no keys are given, so
      // an AWS deployment can use an instance role and hold no secrets at all
      ...(accessKeyId && secretAccessKey
        ? { credentials: { accessKeyId, secretAccessKey } }
        : {}),
    });
  }
  return { mod, client };
}

function bucket(): string {
  const b = process.env.S3_BUCKET;
  if (!b) throw new Error("S3_BUCKET is not set but STORAGE_DRIVER=s3");
  return b;
}

/** Reset between tests, and after an env change in a long-lived process. */
export function __resetS3ClientForTests(): void {
  client = null;
  mod = null;
}

export function s3Driver(): StorageDriver {
  return {
    name: "s3",

    async put(key, body, contentType) {
      const { mod, client } = await sdk();
      const input: PutObjectCommandInput = {
        Bucket: bucket(),
        Key: key,
        Body: body,
        ContentType: contentType,
      };
      await client.send(new mod.PutObjectCommand(input));
    },

    async get(key): Promise<StoredObject | null> {
      const { mod, client } = await sdk();
      const input: GetObjectCommandInput = { Bucket: bucket(), Key: key };
      try {
        const res = await client.send(new mod.GetObjectCommand(input));
        const bytes = await res.Body?.transformToByteArray();
        if (!bytes) return null;
        return {
          body: Buffer.from(bytes),
          // trust the extension over the stored header: a file uploaded before
          // the content type was recorded would otherwise serve as octet-stream
          contentType: contentTypeFor(key) || res.ContentType || "application/octet-stream",
        };
      } catch {
        return null;
      }
    },

    async delete(key) {
      const { mod, client } = await sdk();
      const input: DeleteObjectCommandInput = { Bucket: bucket(), Key: key };
      await client.send(new mod.DeleteObjectCommand(input));
    },

    async exists(key) {
      const { mod, client } = await sdk();
      const input: HeadObjectCommandInput = { Bucket: bucket(), Key: key };
      try {
        await client.send(new mod.HeadObjectCommand(input));
        return true;
      } catch {
        return false;
      }
    },

    async list(prefix = "") {
      const { mod, client } = await sdk();
      const keys: string[] = [];
      let token: string | undefined;
      // a bucket can hold more than one page; the sweep must see all of it or
      // it would "find" orphans that are simply on page two
      do {
        const input: ListObjectsV2CommandInput = {
          Bucket: bucket(),
          Prefix: prefix || undefined,
          ContinuationToken: token,
        };
        const res = await client.send(new mod.ListObjectsV2Command(input));
        for (const o of res.Contents ?? []) if (o.Key) keys.push(o.Key);
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (token);
      return keys;
    },
  };
}
