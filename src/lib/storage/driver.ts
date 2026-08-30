/** A stored object's bytes plus what is needed to serve it back. */
export interface StoredObject {
  body: Buffer;
  contentType: string;
}

/**
 * The storage contract. Deliberately small: this app only ever needs to put a
 * file, read it back, delete it, and ask whether it is there.
 *
 * `list` exists solely for the orphan sweep, which has to enumerate what is in
 * the store to compare it against the database.
 */
export interface StorageDriver {
  readonly name: "disk" | "s3";
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** Every key under a prefix. Used by the orphan sweep, not by request paths. */
  list(prefix?: string): Promise<string[]>;
}
