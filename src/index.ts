/**
 * Tai Network SDK
 * Interact with Walrus storage and Tai Nodes.
 */

// Walrus endpoints
const WALRUS_AGGREGATOR_TESTNET = 'https://aggregator.walrus-testnet.walrus.space';
const WALRUS_PUBLISHER_TESTNET = 'https://publisher.walrus-testnet.walrus.space';
const WALRUS_AGGREGATOR_MAINNET = 'https://aggregator.wal.cloud';
const WALRUS_PUBLISHER_MAINNET = 'https://publisher.wal.cloud';

export type WalrusNetwork = 'mainnet' | 'testnet';

// 10MB Chunks for large file support
const CHUNK_SIZE = 10 * 1024 * 1024;

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
    epochs?: number; // Storage duration in epochs (default: 5)
}

/**
 * Get Walrus endpoints for network
 */
function getEndpoints(network: WalrusNetwork) {
    return {
        aggregator: network === 'mainnet' ? WALRUS_AGGREGATOR_MAINNET : WALRUS_AGGREGATOR_TESTNET,
        publisher: network === 'mainnet' ? WALRUS_PUBLISHER_MAINNET : WALRUS_PUBLISHER_TESTNET,
    };
}

/**
 * Upload a single blob to Walrus storage
 */
export async function uploadToWalrus(
    file: File | Blob | any,
    config: WalrusConfig = { network: 'testnet' }
): Promise<WalrusUploadResult> {
    const { publisher, aggregator } = getEndpoints(config.network);
    const epochs = config.epochs || 5;

    // Upload via publisher
    const response = await fetch(`${publisher}/v1/blobs?epochs=${epochs}`, {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/octet-stream', // Generic binary for chunks
        },
        body: file,
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Walrus upload failed: ${error}`);
    }

    const data = await response.json();

    // Handle both newlyCreated and alreadyCertified responses
    const blobInfo = data.newlyCreated?.blobObject || data.alreadyCertified?.blobObject;
    const blobId = blobInfo?.blobId || data.blobId;

    if (!blobId) {
        throw new Error('No blob ID in response');
    }

    // Handle size logic safely
    let size = 0;
    if (file && typeof file.size === 'number') size = file.size;
    else if (file && typeof file.length === 'number') size = file.length;

    return {
        blobId,
        suiObjectId: blobInfo?.id,
        url: `${aggregator}/v1/blobs/${blobId}`,
        size: size,
        mediaType: file.type || 'application/octet-stream',
    };
}

/**
 * Upload a large video file by splitting it into chunks
 * Returns the Blob ID of the Manifest file
 */
export async function uploadVideo(
    file: File,
    title: string,
    config: WalrusConfig = { network: 'testnet' }
): Promise<WalrusUploadResult> {
    const totalSize = file.size;
    const totalChunks = Math.ceil(totalSize / CHUNK_SIZE);
    const uploadedChunks: VideoChunk[] = [];

    console.log(`[TaiSDK] Starting upload: ${title} (${(totalSize / 1024 / 1024).toFixed(2)} MB in ${totalChunks} chunks)`);

    // 1. Upload Chunks (sequentially for safety, could be parallelized)
    for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, totalSize);
        const chunkBlob = file.slice(start, end);

        console.log(`[TaiSDK] Uploading chunk ${i + 1}/${totalChunks}...`);

        try {
            const result = await uploadToWalrus(chunkBlob, config);
            uploadedChunks.push({
                index: i,
                blobId: result.blobId,
                offsetStart: start,
                offsetEnd: end,
                size: chunkBlob.size
            });
        } catch (err) {
            console.error(`[TaiSDK] Chunk ${i} failed`, err);
            throw err;
        }
    }

    // 2. Create Manifest
    const manifest: TaiManifest = {
        version: '1.0',
        title,
        durationMs: 0,
        mimeType: file.type,
        totalSize,
        createdAt: Date.now(),
        chunks: uploadedChunks
    };

    // 3. Upload Manifest
    const manifestBlob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
    console.log(`[TaiSDK] Uploading Manifest...`);

    return uploadToWalrus(manifestBlob, config);
}

/**
 * Get a blob URL from Walrus (Direct or via Tai Node)
 */
export function getWalrusUrl(blobId: string, network: WalrusNetwork = 'testnet'): string {
    const { aggregator } = getEndpoints(network);
    return `${aggregator}/v1/blobs/${blobId}`;
}

/**
 * Download a blob from Walrus
 */
export async function downloadFromWalrus(
    blobId: string,
    network: WalrusNetwork = 'testnet'
): Promise<Blob> {
    const url = getWalrusUrl(blobId, network);
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`Walrus download failed: ${response.statusText}`);
    }

    return response.blob();
}

/**
 * Check if a blob exists in Walrus
 */
export async function blobExists(
    blobId: string,
    network: WalrusNetwork = 'testnet'
): Promise<boolean> {
    const url = getWalrusUrl(blobId, network);

    try {
        const response = await fetch(url, { method: 'HEAD' });
        return response.ok;
    } catch {
        return false;
    }
}
