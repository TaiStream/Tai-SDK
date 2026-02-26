/**
 * Tai Network SDK
 * Interact with Walrus storage and Tai Nodes.
 * Works in both Node.js (>=18) and browser environments.
 */

// Re-export all types
export type {
    WalrusNetwork,
    WalrusUploadResult,
    VideoChunk,
    TaiManifest,
    WalrusConfig,
    UploadInput,
    UploadVideoOptions,
    DownloadRangeResult,
    TaiSDKEvents,
} from './types';

import type {
    WalrusConfig,
    WalrusUploadResult,
    UploadInput,
    VideoChunk,
    TaiManifest,
    UploadVideoOptions,
    DownloadRangeResult,
    TaiSDKEvents,
} from './types';

import {
    getEndpoints,
    normalizeBody,
    fetchWithRetry,
    fetchWithTimeout,
    encrypt,
    decrypt,
} from './internal';

// Re-export internals consumers may need
export { normalizeBody } from './internal';

// 10MB Chunks for large file support
const CHUNK_SIZE = 10 * 1024 * 1024;

/**
 * Upload error with resumable chunk state
 */
export class UploadError extends Error {
    public uploadedChunks: VideoChunk[];
    constructor(message: string, uploadedChunks: VideoChunk[]) {
        super(message);
        this.uploadedChunks = uploadedChunks;
        this.name = 'UploadError';
    }
}

// ---------------------------------------------------------------------------
// Standalone functions (backward compatible)
// ---------------------------------------------------------------------------

/**
 * Upload a single blob to Walrus storage
 */
export async function uploadToWalrus(
    input: UploadInput,
    config: WalrusConfig = { network: 'testnet' },
    _onRetry?: TaiSDKEvents['onRetry']
): Promise<WalrusUploadResult> {
    const { publisher, aggregator } = getEndpoints(config);
    const epochs = config.epochs || 5;
    const { body, size } = normalizeBody(input);

    const response = await fetchWithRetry(
        `${publisher}/v1/blobs?epochs=${epochs}`,
        {
            method: 'PUT',
            headers: { 'Content-Type': 'application/octet-stream' },
            body,
        },
        3,
        1_000,
        _onRetry
    );

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Walrus upload failed (${response.status}): ${error}`);
    }

    const data = await response.json();

    // Handle both newlyCreated and alreadyCertified responses
    const blobInfo = data.newlyCreated?.blobObject || data.alreadyCertified?.blobObject;
    const blobId = blobInfo?.blobId || data.alreadyCertified?.blobId || data.newlyCreated?.blobObject?.blobId;

    if (!blobId) {
        throw new Error(`No blob ID in Walrus response: ${JSON.stringify(data)}`);
    }

    return {
        blobId,
        suiObjectId: blobInfo?.id,
        url: `${aggregator}/v1/blobs/${blobId}`,
        size,
        mediaType: 'application/octet-stream',
    };
}

/**
 * Get a blob URL from Walrus
 */
export function getWalrusUrl(blobId: string, config: WalrusConfig = { network: 'testnet' }): string {
    const { aggregator } = getEndpoints(config);
    return `${aggregator}/v1/blobs/${blobId}`;
}

/**
 * Download a blob from Walrus as Uint8Array
 */
export async function downloadFromWalrus(
    blobId: string,
    config: WalrusConfig = { network: 'testnet' },
    _onRetry?: TaiSDKEvents['onRetry']
): Promise<Uint8Array> {
    const url = getWalrusUrl(blobId, config);
    const response = await fetchWithRetry(url, undefined, 3, 1_000, _onRetry);

    if (!response.ok) {
        throw new Error(`Walrus download failed (${response.status}): ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return new Uint8Array(arrayBuffer);
}

/**
 * Download and parse a Tai manifest
 */
export async function downloadManifest(
    blobId: string,
    config: WalrusConfig = { network: 'testnet' }
): Promise<TaiManifest> {
    const data = await downloadFromWalrus(blobId, config);
    const text = new TextDecoder().decode(data);
    return JSON.parse(text) as TaiManifest;
}

/**
 * Check if a blob exists in Walrus
 */
export async function blobExists(
    blobId: string,
    config: WalrusConfig = { network: 'testnet' }
): Promise<boolean> {
    const url = getWalrusUrl(blobId, config);
    try {
        const response = await fetchWithTimeout(url, { method: 'HEAD' });
        return response.ok;
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// uploadVideo — backward-compatible + new options-based overload
// ---------------------------------------------------------------------------

/** Detect whether second arg is UploadVideoOptions or a string title */
function isUploadVideoOptions(arg: unknown): arg is UploadVideoOptions {
    return typeof arg === 'object' && arg !== null && 'title' in arg;
}

/**
 * Upload a large file by splitting into chunks + manifest.
 *
 * Overload 1 (legacy):
 *   uploadVideo(data, title, mimeType?, config?, onProgress?, existingChunks?)
 *
 * Overload 2 (new):
 *   uploadVideo(data, options: UploadVideoOptions, config?)
 */
export async function uploadVideo(
    data: Blob | Uint8Array | ArrayBuffer,
    titleOrOptions: string | UploadVideoOptions,
    mimeTypeOrConfig?: string | WalrusConfig,
    configOrOnProgress?: WalrusConfig | ((chunkIndex: number, totalChunks: number) => void),
    onProgressLegacy?: (chunkIndex: number, totalChunks: number) => void,
    existingChunksLegacy?: VideoChunk[]
): Promise<WalrusUploadResult> {
    // Normalize arguments
    let title: string;
    let mimeType: string;
    let config: WalrusConfig;
    let onProgress: ((info: { chunkIndex: number; totalChunks: number; bytesUploaded: number }) => void) | undefined;
    let existingChunks: VideoChunk[];
    let concurrency: number;
    let durationMs: number;
    let shouldEncrypt = false;
    let encryptionKey: Uint8Array | undefined;

    if (isUploadVideoOptions(titleOrOptions)) {
        // New overload
        const opts = titleOrOptions;
        title = opts.title;
        mimeType = opts.mimeType || 'video/mp4';
        config = (mimeTypeOrConfig as WalrusConfig) || { network: 'testnet' };
        onProgress = opts.onProgress;
        existingChunks = opts.existingChunks || [];
        concurrency = opts.concurrency || 3;
        durationMs = opts.durationMs || 0;
        shouldEncrypt = opts.encrypt || false;
        encryptionKey = opts.encryptionKey;
    } else {
        // Legacy overload
        title = titleOrOptions;
        mimeType = (typeof mimeTypeOrConfig === 'string' ? mimeTypeOrConfig : undefined) || 'video/mp4';
        config = (typeof mimeTypeOrConfig === 'string'
            ? (configOrOnProgress as WalrusConfig)
            : (mimeTypeOrConfig as WalrusConfig)) || { network: 'testnet' };
        const legacyCb = typeof configOrOnProgress === 'function' ? configOrOnProgress : onProgressLegacy;
        onProgress = legacyCb
            ? (info) => legacyCb(info.chunkIndex, info.totalChunks)
            : undefined;
        existingChunks = existingChunksLegacy || [];
        concurrency = 3;
        durationMs = 0;
    }

    if (!Number.isInteger(concurrency) || concurrency < 1) {
        throw new Error(`Invalid concurrency value: ${concurrency}. Use an integer >= 1.`);
    }

    // Get total size
    let totalSize: number;
    totalSize = data instanceof Blob ? data.size : data.byteLength;

    const totalChunks = Math.ceil(totalSize / CHUNK_SIZE);
    const uploadedChunks: VideoChunk[] = [...existingChunks].sort((a, b) => a.index - b.index);

    console.log(`[TaiSDK] Uploading "${title}" (${(totalSize / 1024 / 1024).toFixed(2)} MB, ${totalChunks} chunk${totalChunks > 1 ? 's' : ''})`);
    if (uploadedChunks.length > 0) {
        console.log(`[TaiSDK] Resuming with ${uploadedChunks.length} chunks already uploaded.`);
    }

    // Build list of chunks that need uploading
    const pending: number[] = [];
    for (let i = 0; i < totalChunks; i++) {
        if (!uploadedChunks.some(c => c.index === i)) {
            pending.push(i);
        } else {
            const bytesUploaded = uploadedChunks
                .filter(c => c.index <= i)
                .reduce((sum, c) => sum + c.size, 0);
            onProgress?.({ chunkIndex: i, totalChunks, bytesUploaded });
        }
    }

    // Concurrency-limited parallel upload
    let runningBytesUploaded = uploadedChunks.reduce((sum, c) => sum + c.size, 0);

    const sliceToUint8Array = async (start: number, end: number): Promise<Uint8Array> => {
        if (data instanceof Blob) {
            return new Uint8Array(await data.slice(start, end).arrayBuffer());
        }
        if (data instanceof Uint8Array) {
            return data.subarray(start, end);
        }
        return new Uint8Array(data, start, end - start);
    };

    const uploadChunk = async (i: number) => {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, totalSize);

        let chunk: UploadInput;
        if (data instanceof Blob) {
            chunk = data.slice(start, end);
        } else if (data instanceof Uint8Array) {
            chunk = data.subarray(start, end);
        } else {
            chunk = new Uint8Array(data, start, end - start);
        }

        console.log(`[TaiSDK] Chunk ${i + 1}/${totalChunks}...`);

        try {
            const result = await uploadToWalrus(chunk, config);
            const chunkSize = end - start;
            runningBytesUploaded += chunkSize;
            uploadedChunks.push({
                index: i,
                blobId: result.blobId,
                offsetStart: start,
                offsetEnd: end,
                size: chunkSize,
            });
            onProgress?.({ chunkIndex: i, totalChunks, bytesUploaded: runningBytesUploaded });
            if (isUploadVideoOptions(titleOrOptions)) {
                titleOrOptions.onChunkUploaded?.({
                    index: i,
                    totalChunks,
                    blobId: result.blobId,
                    size: chunkSize,
                    bytesUploaded: runningBytesUploaded,
                });
            }
        } catch (err: any) {
            throw new UploadError(`Failed to upload chunk ${i}: ${err.message}`, uploadedChunks);
        }
    };

    // Pre-generate encryption key before parallel uploads to avoid race
    if (shouldEncrypt && !encryptionKey) {
        const tempKey = await crypto.subtle.generateKey(
            { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
        );
        encryptionKey = new Uint8Array(await crypto.subtle.exportKey('raw', tempKey));
    }

    // Wrap uploadChunk with optional encryption (key is now stable)
    const uploadChunkMaybeEncrypt = async (i: number) => {
        if (shouldEncrypt) {
            // Encrypt chunk data before upload — runs inside the pool
            // so concurrency is safe since encryptionKey is stable
            const start = i * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE, totalSize);
            const raw = await sliceToUint8Array(start, end);
            const encrypted = await encrypt(raw, encryptionKey);
            // Temporarily replace the uploadChunk's slice logic by uploading directly
            console.log(`[TaiSDK] Chunk ${i + 1}/${totalChunks} (encrypted)...`);
            try {
                const result = await uploadToWalrus(encrypted.ciphertext, config);
                const chunkSize = end - start;
                runningBytesUploaded += chunkSize;
                uploadedChunks.push({
                    index: i,
                    blobId: result.blobId,
                    offsetStart: start,
                    offsetEnd: end,
                    size: chunkSize,
                });
                onProgress?.({ chunkIndex: i, totalChunks, bytesUploaded: runningBytesUploaded });
                if (isUploadVideoOptions(titleOrOptions)) {
                    titleOrOptions.onChunkUploaded?.({
                        index: i,
                        totalChunks,
                        blobId: result.blobId,
                        size: chunkSize,
                        bytesUploaded: runningBytesUploaded,
                    });
                }
            } catch (err: any) {
                throw new UploadError(`Failed to upload chunk ${i}: ${err.message}`, uploadedChunks);
            }
        } else {
            await uploadChunk(i);
        }
    };

    // Concurrency-limited pool
    const executing = new Set<Promise<void>>();
    for (const i of pending) {
        const p = uploadChunkMaybeEncrypt(i).then(
            () => { executing.delete(p); },
            (err) => { executing.delete(p); throw err; }
        );
        executing.add(p);
        if (executing.size >= concurrency) {
            await Promise.race(executing);
        }
    }
    await Promise.all(executing);

    // Sort uploaded chunks by index for manifest
    uploadedChunks.sort((a, b) => a.index - b.index);

    // Create & upload manifest
    const manifest: TaiManifest = {
        version: '1.0',
        title,
        durationMs,
        mimeType,
        totalSize,
        createdAt: Date.now(),
        chunks: uploadedChunks,
    };

    const manifestJson = JSON.stringify(manifest, null, 2);
    console.log(`[TaiSDK] Uploading manifest...`);

    return uploadToWalrus(manifestJson, config);
}

// ---------------------------------------------------------------------------
// New functions
// ---------------------------------------------------------------------------

/**
 * Download a byte range from a chunked video manifest.
 * Fetches only the overlapping chunks and slices to the exact range.
 */
export async function downloadRange(
    manifestBlobId: string,
    startByte: number,
    endByte: number,
    config: WalrusConfig = { network: 'testnet' }
): Promise<DownloadRangeResult> {
    if (!Number.isFinite(startByte) || !Number.isFinite(endByte)) {
        throw new Error('startByte and endByte must be finite numbers');
    }
    if (startByte < 0 || endByte < 0) {
        throw new Error('startByte and endByte must be >= 0');
    }
    if (endByte < startByte) {
        throw new Error('endByte must be >= startByte');
    }

    const manifest = await downloadManifest(manifestBlobId, config);
    const clampedEnd = Math.min(endByte, manifest.totalSize);
    if (startByte >= clampedEnd) {
        return { data: new Uint8Array(0), manifest, chunksUsed: 0 };
    }

    // Find overlapping chunks
    const overlapping = manifest.chunks.filter(
        c => c.offsetEnd > startByte && c.offsetStart < clampedEnd
    );

    if (overlapping.length === 0) {
        return { data: new Uint8Array(0), manifest, chunksUsed: 0 };
    }

    // Download overlapping chunks in order
    const buffers: Uint8Array[] = [];
    for (const chunk of overlapping) {
        const chunkData = await downloadFromWalrus(chunk.blobId, config);
        buffers.push(chunkData);
    }

    // Concatenate
    const totalLen = buffers.reduce((sum, b) => sum + b.byteLength, 0);
    const combined = new Uint8Array(totalLen);
    let offset = 0;
    for (const buf of buffers) {
        combined.set(buf, offset);
        offset += buf.byteLength;
    }

    // Slice to exact range relative to the first overlapping chunk
    const firstChunkStart = overlapping[0].offsetStart;
    const sliceStart = startByte - firstChunkStart;
    const sliceEnd = sliceStart + (clampedEnd - startByte);
    const data = combined.slice(sliceStart, sliceEnd);

    return { data, manifest, chunksUsed: overlapping.length };
}

/**
 * Encrypt data with AES-256-GCM then upload to Walrus
 */
export async function uploadEncrypted(
    input: UploadInput,
    config: WalrusConfig = { network: 'testnet' },
    key?: Uint8Array
): Promise<{ result: WalrusUploadResult; key: Uint8Array }> {
    const { body, size: _size } = normalizeBody(input);

    // Convert body to Uint8Array for encryption
    let raw: Uint8Array;
    if (body instanceof Blob) {
        raw = new Uint8Array(await body.arrayBuffer());
    } else if (body instanceof Uint8Array) {
        raw = body;
    } else if (body instanceof ArrayBuffer) {
        raw = new Uint8Array(body);
    } else {
        // BodyInit string fallback
        raw = new TextEncoder().encode(body as string);
    }

    const encrypted = await encrypt(raw, key);
    const result = await uploadToWalrus(encrypted.ciphertext, config);
    return { result, key: encrypted.key };
}

/**
 * Download from Walrus then decrypt with AES-256-GCM
 */
export async function downloadDecrypted(
    blobId: string,
    key: Uint8Array,
    config: WalrusConfig = { network: 'testnet' }
): Promise<Uint8Array> {
    const packed = await downloadFromWalrus(blobId, config);
    return decrypt(packed, key);
}

// ---------------------------------------------------------------------------
// TaiClient class — wraps standalone functions with persistent config + events
// ---------------------------------------------------------------------------

export class TaiClient {
    private config: WalrusConfig;
    private events: TaiSDKEvents;

    constructor(config: WalrusConfig, events?: TaiSDKEvents) {
        this.config = config;
        this.events = events || {};
    }

    async upload(input: UploadInput): Promise<WalrusUploadResult> {
        return uploadToWalrus(input, this.config, this.events.onRetry);
    }

    async uploadVideo(
        data: Blob | Uint8Array | ArrayBuffer,
        options: UploadVideoOptions
    ): Promise<WalrusUploadResult> {
        const startTime = Date.now();
        const totalSize = data instanceof Blob ? data.size : data.byteLength;
        const totalChunks = Math.ceil(totalSize / CHUNK_SIZE);

        this.events.onUploadStart?.({ totalSize, totalChunks });

        // Wrap onProgress + onChunkUploaded to emit client events
        const originalOnProgress = options.onProgress;
        const originalOnChunkUploaded = options.onChunkUploaded;
        const chunkStartTimes = new Map<number, number>();
        for (let i = 0; i < totalChunks; i++) {
            chunkStartTimes.set(i, Date.now());
        }
        const wrappedOptions: UploadVideoOptions = {
            ...options,
            onProgress: (info) => {
                originalOnProgress?.(info);
            },
            onChunkUploaded: (info) => {
                originalOnChunkUploaded?.(info);
                const elapsed = Date.now() - (chunkStartTimes.get(info.index) || startTime);
                this.events.onChunkUploaded?.({
                    index: info.index,
                    totalChunks: info.totalChunks,
                    blobId: info.blobId,
                    durationMs: elapsed,
                });
            },
        };

        const result = await uploadVideo(data, wrappedOptions, this.config);

        this.events.onUploadComplete?.({
            manifestBlobId: result.blobId,
            totalMs: Date.now() - startTime,
            totalBytes: totalSize,
        });

        return result;
    }

    async download(blobId: string): Promise<Uint8Array> {
        return downloadFromWalrus(blobId, this.config, this.events.onRetry);
    }

    async downloadRange(
        manifestBlobId: string,
        startByte: number,
        endByte: number
    ): Promise<DownloadRangeResult> {
        return downloadRange(manifestBlobId, startByte, endByte, this.config);
    }

    async downloadManifest(blobId: string): Promise<TaiManifest> {
        return downloadManifest(blobId, this.config);
    }

    async exists(blobId: string): Promise<boolean> {
        return blobExists(blobId, this.config);
    }

    getUrl(blobId: string): string {
        return getWalrusUrl(blobId, this.config);
    }

    async uploadEncrypted(
        input: UploadInput,
        key?: Uint8Array
    ): Promise<{ result: WalrusUploadResult; key: Uint8Array }> {
        return uploadEncrypted(input, this.config, key);
    }

    async downloadDecrypted(blobId: string, key: Uint8Array): Promise<Uint8Array> {
        return downloadDecrypted(blobId, key, this.config);
    }
}
