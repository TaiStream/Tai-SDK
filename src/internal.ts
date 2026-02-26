/**
 * Tai Network SDK — Internal utilities
 * Retry, timeout, body normalization, crypto helpers.
 */

import type { UploadInput, WalrusConfig } from './types';

// Walrus endpoints
const WALRUS_AGGREGATOR_TESTNET = 'https://aggregator.walrus-testnet.walrus.space';
const WALRUS_PUBLISHER_TESTNET = 'https://publisher.walrus-testnet.walrus.space';
const WALRUS_AGGREGATOR_MAINNET = 'https://aggregator.wal.cloud';
const WALRUS_PUBLISHER_MAINNET = 'https://publisher.wal.cloud';

/**
 * Get Walrus endpoints for network
 */
export function getEndpoints(config: WalrusConfig) {
    const network = config.network;
    return {
        aggregator: config.aggregatorUrl || (network === 'mainnet' ? WALRUS_AGGREGATOR_MAINNET : WALRUS_AGGREGATOR_TESTNET),
        publisher: config.publisherUrl || (network === 'mainnet' ? WALRUS_PUBLISHER_MAINNET : WALRUS_PUBLISHER_TESTNET),
    };
}

/**
 * Normalize input to a format fetch() can send as body
 */
export function normalizeBody(input: UploadInput): { body: BodyInit; size: number } {
    if (typeof input === 'string') {
        const encoded = new TextEncoder().encode(input);
        return { body: encoded, size: encoded.byteLength };
    }
    if (input instanceof ArrayBuffer) {
        return { body: new Uint8Array(input), size: input.byteLength };
    }
    if (input instanceof Blob) {
        return { body: input, size: input.size };
    }
    // Uint8Array (Node.js Buffer also works because Buffer extends Uint8Array)
    if (input instanceof Uint8Array) {
        const len = input.byteLength;
        const copy = new ArrayBuffer(len);
        const view = new Uint8Array(copy);
        for (let i = 0; i < len; i++) view[i] = (input as Uint8Array)[i];
        return { body: new Blob([copy]), size: len };
    }
    throw new Error('Unsupported input type. Provide Blob, Uint8Array, ArrayBuffer, or string.');
}

/**
 * fetch() with AbortController-based timeout
 */
export async function fetchWithTimeout(
    url: string,
    init?: RequestInit,
    timeoutMs: number = 30_000
): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { ...init, signal: controller.signal });
        return response;
    } catch (err: any) {
        if (err.name === 'AbortError') {
            throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * fetch() with exponential-backoff retry
 */
export async function fetchWithRetry(
    url: string,
    init?: RequestInit,
    retries: number = 3,
    baseDelay: number = 1_000,
    onRetry?: (info: { operation: string; attempt: number; maxRetries: number; error: Error }) => void
): Promise<Response> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const response = await fetchWithTimeout(url, init);
            return response;
        } catch (err: any) {
            lastError = err;
            if (attempt < retries) {
                const delay = baseDelay * Math.pow(2, attempt);
                onRetry?.({ operation: url, attempt: attempt + 1, maxRetries: retries, error: err });
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    throw lastError!;
}

// --- AES-256-GCM Crypto ---

const IV_LENGTH = 12;

/**
 * Encrypt data with AES-256-GCM.
 * Returns packed format: [12-byte IV][ciphertext+tag]
 */
export async function encrypt(
    data: Uint8Array,
    key?: Uint8Array
): Promise<{ ciphertext: Uint8Array; key: Uint8Array; iv: Uint8Array }> {
    const toAB = (arr: Uint8Array): ArrayBuffer =>
        arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength) as ArrayBuffer;

    const cryptoKey = key && key.length === 32
        ? await crypto.subtle.importKey('raw', toAB(key), 'AES-GCM', true, ['encrypt'])
        : await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);

    const exportedKey = new Uint8Array(await crypto.subtle.exportKey(
        'raw',
        cryptoKey as CryptoKey
    ));

    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        cryptoKey as CryptoKey,
        toAB(data)
    );

    // Pack: [IV][ciphertext+tag]
    const packed = new Uint8Array(IV_LENGTH + encrypted.byteLength);
    packed.set(iv, 0);
    packed.set(new Uint8Array(encrypted), IV_LENGTH);

    return { ciphertext: packed, key: exportedKey, iv };
}

/**
 * Decrypt data encrypted with encrypt().
 * Expects packed format: [12-byte IV][ciphertext+tag]
 */
export async function decrypt(
    packed: Uint8Array,
    key: Uint8Array
): Promise<Uint8Array> {
    const iv = packed.slice(0, IV_LENGTH);
    const ciphertext = packed.slice(IV_LENGTH);

    const toAB = (arr: Uint8Array): ArrayBuffer =>
        arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength) as ArrayBuffer;

    const cryptoKey = await crypto.subtle.importKey('raw', toAB(key), 'AES-GCM', false, ['decrypt']);
    const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: toAB(iv) },
        cryptoKey,
        toAB(ciphertext)
    );

    return new Uint8Array(decrypted);
}
