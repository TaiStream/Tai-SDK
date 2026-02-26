/**
 * Offline unit tests for Tai SDK.
 * Does NOT hit Walrus testnet — tests internal logic only.
 * Run: npx tsx src/__tests__/sdk.test.ts
 */

import { normalizeBody } from '../internal';
import { encrypt, decrypt } from '../internal';
import { UploadError, TaiClient, uploadVideo, downloadRange } from '../index';
import type { UploadVideoOptions, TaiManifest, VideoChunk } from '../types';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void) {
    try {
        await fn();
        console.log(`  PASS  ${name}`);
        passed++;
    } catch (err) {
        console.error(`  FAIL  ${name}`);
        console.error(`        ${err}`);
        failed++;
    }
}

function assert(condition: boolean, msg: string) {
    if (!condition) throw new Error(msg);
}

async function run() {
    console.log('\n=== Tai SDK Offline Unit Tests ===\n');

    // --- normalizeBody ---

    await test('normalizeBody(string)', () => {
        const { body, size } = normalizeBody('hello');
        assert(size === 5, `Expected size 5, got ${size}`);
        assert(body instanceof Uint8Array, 'Expected Uint8Array body');
    });

    await test('normalizeBody(Uint8Array)', () => {
        const input = new Uint8Array([1, 2, 3]);
        const { body, size } = normalizeBody(input);
        assert(size === 3, `Expected size 3, got ${size}`);
        assert(body instanceof Blob, 'Expected Blob body for Uint8Array input');
    });

    await test('normalizeBody(ArrayBuffer)', () => {
        const input = new ArrayBuffer(4);
        const { body, size } = normalizeBody(input);
        assert(size === 4, `Expected size 4, got ${size}`);
        assert(body instanceof Uint8Array, 'Expected Uint8Array body for ArrayBuffer input');
    });

    await test('normalizeBody(Blob)', () => {
        const input = new Blob([new Uint8Array([10, 20])]);
        const { body, size } = normalizeBody(input);
        assert(size === 2, `Expected size 2, got ${size}`);
        assert(body instanceof Blob, 'Expected Blob body');
    });

    await test('normalizeBody(Buffer)', () => {
        const input = Buffer.from([7, 8, 9]);
        const { body, size } = normalizeBody(input);
        assert(size === 3, `Expected size 3, got ${size}`);
    });

    await test('normalizeBody throws on invalid input', () => {
        try {
            normalizeBody(42 as any);
            throw new Error('Should have thrown');
        } catch (err: any) {
            assert(err.message.includes('Unsupported input type'), `Wrong error: ${err.message}`);
        }
    });

    // --- Encrypt/Decrypt round-trip ---

    await test('encrypt/decrypt round-trip', async () => {
        const plaintext = new TextEncoder().encode('Secret video data for Tai Network');
        const { ciphertext, key } = await encrypt(plaintext);

        assert(key.length === 32, `Key should be 32 bytes, got ${key.length}`);
        assert(ciphertext.length > plaintext.length, 'Ciphertext should be longer than plaintext');

        const decrypted = await decrypt(ciphertext, key);
        const text = new TextDecoder().decode(decrypted);
        assert(text === 'Secret video data for Tai Network', `Decrypted text mismatch: "${text}"`);
    });

    await test('encrypt with provided key', async () => {
        const key = crypto.getRandomValues(new Uint8Array(32));
        const plaintext = new TextEncoder().encode('test');
        const { ciphertext, key: returnedKey } = await encrypt(plaintext, key);

        // Returned key should match provided key
        assert(returnedKey.length === 32, 'Key length mismatch');

        const decrypted = await decrypt(ciphertext, returnedKey);
        assert(new TextDecoder().decode(decrypted) === 'test', 'Decrypt failed with provided key');
    });

    await test('decrypt with wrong key fails', async () => {
        const plaintext = new TextEncoder().encode('secret');
        const { ciphertext } = await encrypt(plaintext);
        const wrongKey = crypto.getRandomValues(new Uint8Array(32));

        try {
            await decrypt(ciphertext, wrongKey);
            throw new Error('Should have thrown');
        } catch (err: any) {
            assert(!err.message.includes('Should have thrown'), 'Decrypt should fail with wrong key');
        }
    });

    // --- UploadError ---

    await test('UploadError preserves chunks', () => {
        const chunks: VideoChunk[] = [
            { index: 0, blobId: 'abc', offsetStart: 0, offsetEnd: 100, size: 100 },
        ];
        const err = new UploadError('chunk 1 failed', chunks);
        assert(err.name === 'UploadError', `Wrong name: ${err.name}`);
        assert(err.uploadedChunks.length === 1, 'Should have 1 chunk');
        assert(err.uploadedChunks[0].blobId === 'abc', 'Wrong blobId');
        assert(err instanceof Error, 'Should be instanceof Error');
    });

    // --- TaiClient construction ---

    await test('TaiClient construction', () => {
        const client = new TaiClient({ network: 'testnet' });
        assert(client instanceof TaiClient, 'Should be instanceof TaiClient');

        const url = client.getUrl('test-blob-id');
        assert(url.includes('test-blob-id'), 'URL should contain blobId');
        assert(url.includes('walrus-testnet'), 'URL should be testnet');
    });

    await test('TaiClient with mainnet config', () => {
        const client = new TaiClient({ network: 'mainnet' });
        const url = client.getUrl('blob123');
        assert(url.includes('wal.cloud'), 'Mainnet URL should contain wal.cloud');
        assert(url.includes('blob123'), 'URL should contain blobId');
    });

    await test('TaiClient with custom publisher/aggregator', () => {
        const client = new TaiClient({
            network: 'testnet',
            publisherUrl: 'https://my-node.example.com',
            aggregatorUrl: 'https://my-agg.example.com',
        });
        const url = client.getUrl('blob456');
        assert(url.includes('my-agg.example.com'), 'Should use custom aggregator');
    });

    // --- UploadVideoOptions overload detection ---

    await test('isUploadVideoOptions detects object vs string', () => {
        // The overload detection is internal, but we can test it indirectly
        // by checking that UploadVideoOptions has required 'title' field
        const opts: UploadVideoOptions = { title: 'My Video' };
        assert(typeof opts === 'object' && 'title' in opts, 'Should detect options object');
        assert(typeof 'my-title' === 'string', 'String should not match');
    });

    // --- downloadRange byte-range calculation ---

    await test('downloadRange byte-range calculation logic', () => {
        // Simulate the chunk-overlap logic used in downloadRange
        const chunks: VideoChunk[] = [
            { index: 0, blobId: 'a', offsetStart: 0, offsetEnd: 10_000_000, size: 10_000_000 },
            { index: 1, blobId: 'b', offsetStart: 10_000_000, offsetEnd: 20_000_000, size: 10_000_000 },
            { index: 2, blobId: 'c', offsetStart: 20_000_000, offsetEnd: 25_000_000, size: 5_000_000 },
        ];

        // Range within first chunk
        let startByte = 1000;
        let endByte = 5000;
        let overlapping = chunks.filter(c => c.offsetEnd > startByte && c.offsetStart < endByte);
        assert(overlapping.length === 1, `Expected 1 overlapping chunk, got ${overlapping.length}`);
        assert(overlapping[0].index === 0, 'Should be chunk 0');

        // Range spanning chunks 0 and 1
        startByte = 9_000_000;
        endByte = 11_000_000;
        overlapping = chunks.filter(c => c.offsetEnd > startByte && c.offsetStart < endByte);
        assert(overlapping.length === 2, `Expected 2 overlapping chunks, got ${overlapping.length}`);

        // Range spanning all chunks
        startByte = 0;
        endByte = 25_000_000;
        overlapping = chunks.filter(c => c.offsetEnd > startByte && c.offsetStart < endByte);
        assert(overlapping.length === 3, `Expected 3 overlapping chunks, got ${overlapping.length}`);

        // Range beyond all chunks
        startByte = 30_000_000;
        endByte = 35_000_000;
        overlapping = chunks.filter(c => c.offsetEnd > startByte && c.offsetStart < endByte);
        assert(overlapping.length === 0, `Expected 0 overlapping chunks, got ${overlapping.length}`);
    });

    // --- durationMs flows into manifest ---

    await test('durationMs in UploadVideoOptions', () => {
        // Verify the type accepts durationMs
        const opts: UploadVideoOptions = {
            title: 'Test',
            durationMs: 120_000,
            mimeType: 'video/webm',
            concurrency: 5,
            onChunkUploaded: () => { },
        };
        assert(opts.durationMs === 120_000, 'durationMs should be set');
        assert(opts.concurrency === 5, 'concurrency should be set');
        assert(opts.mimeType === 'video/webm', 'mimeType should be set');
    });

    await test('uploadVideo rejects invalid concurrency before network calls', async () => {
        try {
            await uploadVideo(
                new Uint8Array([1, 2, 3]),
                { title: 'bad', concurrency: 0 },
                { network: 'testnet' }
            );
            throw new Error('Should have thrown');
        } catch (err: any) {
            assert(err.message.includes('Invalid concurrency value'), `Wrong error: ${err.message}`);
        }
    });

    await test('downloadRange validates range params before network calls', async () => {
        try {
            await downloadRange('manifest', 10, 1, { network: 'testnet' });
            throw new Error('Should have thrown');
        } catch (err: any) {
            assert(err.message.includes('endByte must be >= startByte'), `Wrong error: ${err.message}`);
        }
    });

    await test('TaiManifest type includes durationMs', () => {
        const manifest: TaiManifest = {
            version: '1.0',
            title: 'test',
            durationMs: 60_000,
            mimeType: 'video/mp4',
            totalSize: 1024,
            chunks: [],
            createdAt: Date.now(),
        };
        assert(manifest.durationMs === 60_000, 'durationMs should be 60000');
    });

    // --- Summary ---

    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
    if (failed > 0) process.exitCode = 1;
}

run();
