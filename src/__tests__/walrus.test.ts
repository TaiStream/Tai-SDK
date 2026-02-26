/**
 * Integration test for Tai SDK against Walrus testnet.
 * Run: npm test
 */

import {
    uploadToWalrus,
    downloadFromWalrus,
    downloadManifest,
    blobExists,
    getWalrusUrl,
    uploadVideo,
} from '../index';

const CONFIG = { network: 'testnet' as const };

let uploadedBlobId: string;

async function test(name: string, fn: () => Promise<void>) {
    try {
        await fn();
        console.log(`  PASS  ${name}`);
    } catch (err) {
        console.error(`  FAIL  ${name}`);
        console.error(`        ${err}`);
        process.exitCode = 1;
    }
}

async function run() {
    console.log('\n=== Tai SDK Integration Tests (Walrus Testnet) ===\n');

    // 1. Upload a string
    await test('uploadToWalrus(string)', async () => {
        const result = await uploadToWalrus('Hello from Tai SDK test!', CONFIG);
        if (!result.blobId) throw new Error('No blobId returned');
        if (!result.url) throw new Error('No url returned');
        if (result.size !== 24) throw new Error(`Expected size 24, got ${result.size}`);
        uploadedBlobId = result.blobId;
        console.log(`        blobId: ${result.blobId}`);
        console.log(`        url: ${result.url}`);
    });

    // 2. Upload a Buffer
    await test('uploadToWalrus(Buffer)', async () => {
        const buf = Buffer.from('Binary data from Node.js buffer');
        const result = await uploadToWalrus(buf, CONFIG);
        if (!result.blobId) throw new Error('No blobId returned');
        console.log(`        blobId: ${result.blobId}`);
    });

    // 3. Upload a Uint8Array
    await test('uploadToWalrus(Uint8Array)', async () => {
        const arr = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"
        const result = await uploadToWalrus(arr, CONFIG);
        if (!result.blobId) throw new Error('No blobId returned');
        console.log(`        blobId: ${result.blobId}`);
    });

    // 4. Check blob exists
    await test('blobExists(valid)', async () => {
        const exists = await blobExists(uploadedBlobId, CONFIG);
        if (!exists) throw new Error('Blob should exist');
    });

    await test('blobExists(invalid)', async () => {
        const exists = await blobExists('nonexistent-blob-id-12345', CONFIG);
        if (exists) throw new Error('Blob should not exist');
    });

    // 5. Download and verify
    await test('downloadFromWalrus', async () => {
        const data = await downloadFromWalrus(uploadedBlobId, CONFIG);
        const text = new TextDecoder().decode(data);
        if (text !== 'Hello from Tai SDK test!') {
            throw new Error(`Expected "Hello from Tai SDK test!", got "${text}"`);
        }
    });

    // 6. getWalrusUrl
    await test('getWalrusUrl', async () => {
        const url = getWalrusUrl('abc123', CONFIG);
        if (!url.includes('abc123')) throw new Error('URL should contain blobId');
        if (!url.includes('walrus-testnet')) throw new Error('URL should be testnet');
    });

    // 7. Upload small "video" (simulate chunking with small data)
    await test('uploadVideo (small buffer)', async () => {
        const fakeVideo = Buffer.alloc(1024, 0x42); // 1KB of 'B'
        const result = await uploadVideo(fakeVideo, 'test-video.mp4', 'video/mp4', CONFIG);
        if (!result.blobId) throw new Error('No manifest blobId returned');

        // Download and verify manifest
        const manifest = await downloadManifest(result.blobId, CONFIG);
        if (manifest.version !== '1.0') throw new Error('Bad manifest version');
        if (manifest.title !== 'test-video.mp4') throw new Error('Bad manifest title');
        if (manifest.totalSize !== 1024) throw new Error(`Bad totalSize: ${manifest.totalSize}`);
        if (manifest.chunks.length !== 1) throw new Error(`Expected 1 chunk, got ${manifest.chunks.length}`);
        console.log(`        manifest blobId: ${result.blobId}`);
        console.log(`        chunks: ${manifest.chunks.length}`);
    });

    console.log('\n=== Done ===\n');
}

run();
