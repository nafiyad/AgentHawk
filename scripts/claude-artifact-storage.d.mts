import type { BigIntStats, Dirent } from "node:fs";

export interface StorageHandle {
  stat(options: { bigint: true }): Promise<BigIntStats>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  write(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesWritten: number }>;
  sync(): Promise<void>;
  close(): Promise<void>;
}
export interface StorageDirectory {
  read(): Promise<Dirent | null>;
  close(): Promise<void>;
}
export interface ArtifactFilesystem {
  realpath(path: string): Promise<string>;
  lstat(path: string, options: { bigint: true }): Promise<BigIntStats>;
  mkdir(path: string, options: { mode: number }): Promise<unknown>;
  open(path: string, flags: number, mode?: number): Promise<StorageHandle>;
}
export interface RuntimeFilesystem extends ArtifactFilesystem {
  opendir(path: string, options: { bufferSize: number }): Promise<StorageDirectory>;
}
export interface BoundedRuntimeFilesystem extends RuntimeFilesystem {
  lstatIfPresent(path: string, options: { bigint: true }): Promise<BigIntStats | undefined>;
}

/** Existing adapter: no raw errors, deletion, or claims of kernel cancellation. */
export function createBoundedArtifactStorage(
  filesystem: ArtifactFilesystem,
  signal: AbortSignal,
): Readonly<{ filesystem: ArtifactFilesystem; settle(): Promise<boolean> }>;
export function createBoundedRuntimeStorage(
  filesystem: RuntimeFilesystem,
  signal: AbortSignal,
): Readonly<{ filesystem: BoundedRuntimeFilesystem; settle(): Promise<boolean> }>;
