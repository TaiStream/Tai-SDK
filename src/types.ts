/**
 * Tai Network SDK — Types & Interfaces
 */

export type WalrusNetwork = 'mainnet' | 'testnet';

export interface WalrusUploadResult {
    blobId: string;
    suiObjectId?: string;
    url: string;
    size: number;
    mediaType: string;
}

export interface VideoChunk {
    index: number;
    blobId: string;
    offsetStart: number;
    offsetEnd: number;
    size: number;
}

export interface TaiManifest {
    version: '1.0';
    title: string;
    durationMs: number;
    mimeType: string;
    totalSize: number;
    chunks: VideoChunk[];
    createdAt: number;
}

export interface WalrusConfig {
    network: WalrusNetwork;
    epochs?: number;
    publisherUrl?: string;
    aggregatorUrl?: string;
}

export type UploadInput = Blob | Uint8Array | ArrayBuffer | string;

export interface UploadVideoOptions {
    title: string;
    mimeType?: string;
    durationMs?: number;
    onProgress?: (info: { chunkIndex: number; totalChunks: number; bytesUploaded: number }) => void;
    onChunkUploaded?: (info: {
        index: number;
        totalChunks: number;
        blobId: string;
        size: number;
        bytesUploaded: number;
    }) => void;
    existingChunks?: VideoChunk[];
    concurrency?: number;
    encrypt?: boolean;
    encryptionKey?: Uint8Array;
}

export interface DownloadRangeResult {
    data: Uint8Array;
    manifest: TaiManifest;
    chunksUsed: number;
}

export interface TaiSDKEvents {
    onUploadStart?: (info: { totalSize: number; totalChunks: number }) => void;
    onChunkUploaded?: (info: { index: number; totalChunks: number; blobId: string; durationMs: number }) => void;
    onUploadComplete?: (info: { manifestBlobId: string; totalMs: number; totalBytes: number }) => void;
    onRetry?: (info: { operation: string; attempt: number; maxRetries: number; error: Error }) => void;
    onError?: (info: { operation: string; error: Error }) => void;
}
