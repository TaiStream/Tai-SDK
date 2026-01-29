# Tai Network SDK

Developer SDK for decentralized video infrastructure on Walrus and Sui. Part of the [Tai Network](../Tai-Docs) ecosystem.

## Overview

The Tai SDK provides a simple interface for:
- Uploading videos to Walrus storage
- Automatic chunking for large files (10MB chunks)
- Manifest generation for video playback
- Direct blob access

## Installation

```bash
npm install @tai-network/sdk
```

## Quick Start

```typescript
import { uploadVideo, getWalrusUrl } from '@tai-network/sdk';

// Upload a video (handles chunking automatically)
const result = await uploadVideo(file, 'My Video', { network: 'testnet' });
console.log('Manifest ID:', result.blobId);

// Get playback URL
const url = getWalrusUrl(result.blobId);
```

## API Reference

### `uploadToWalrus(file, config)`

Upload a single blob to Walrus storage.

```typescript
const result = await uploadToWalrus(file, {
  network: 'testnet',
  epochs: 5  // Storage duration
});
// Returns: { blobId, url, size, mediaType }
```

### `uploadVideo(file, title, config)`

Upload a video with automatic chunking and manifest creation.

```typescript
const result = await uploadVideo(videoFile, 'Video Title', {
  network: 'testnet'
});
// Returns manifest blob info
```

### `getWalrusUrl(blobId, network)`

Get direct URL to a Walrus blob.

```typescript
const url = getWalrusUrl('abc123...', 'testnet');
// Returns: https://aggregator.walrus-testnet.walrus.space/v1/blobs/abc123...
```

### `downloadFromWalrus(blobId, network)`

Download a blob from Walrus.

```typescript
const blob = await downloadFromWalrus('abc123...', 'testnet');
```

### `blobExists(blobId, network)`

Check if a blob exists in Walrus.

```typescript
const exists = await blobExists('abc123...', 'testnet');
```

## Types

```typescript
interface WalrusConfig {
  network: 'mainnet' | 'testnet';
  epochs?: number;  // Default: 5
}

interface WalrusUploadResult {
  blobId: string;
  suiObjectId?: string;
  url: string;
  size: number;
  mediaType: string;
}

interface TaiManifest {
  version: '1.0';
  title: string;
  durationMs: number;
  mimeType: string;
  totalSize: number;
  chunks: VideoChunk[];
  createdAt: number;
}
```

## Chunking

Files larger than 10MB are automatically split into chunks:

1. Each chunk is uploaded separately to Walrus
2. A manifest JSON is created linking all chunks
3. The manifest blob ID is returned for playback

This enables:
- Resumable uploads
- Efficient seeking (HTTP Range requests)
- Parallel chunk downloads

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Test
npm test
```

## Related

- [Tai-Live](../Tai-Live) — Streaming platform using this SDK
- [Tai-Meet](../Tai-Meet) — Video conferencing
- [Tai-Node-Package](../Tai-Node-Package) — Caching nodes
- [Tai-Docs](../Tai-Docs) — Documentation

## License

MIT
