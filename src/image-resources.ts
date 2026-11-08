/** Generic, session-bound immutable image resources. No model/presentation policy. */
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { openArtifact } from './artifacts.js';
export const IMAGE_LIMIT = 8 * 1024 * 1024;
const SESSION_BYTES = 256 * 1024 * 1024, SESSION_COUNT = 200;
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
const idRE = /^[a-f0-9]{64}$/, sessionRE = /^[a-f0-9]{4,32}$/;
export interface ImageMetadata {
    id: string;
    mimeType: string;
    width: number;
    height: number;
    size: number;
    name: string;
}
export interface ImageResourceAccess {
    publish(path: string, signal?: AbortSignal): Promise<ImageMetadata & {
        ref: string;
    }>;
}
export function inspectImage(b: Buffer): {
    mimeType: string;
    width: number;
    height: number;
} {
    let width = 0, height = 0, mimeType = '';
    if (b.length >= 45 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        if (b.readUInt32BE(8) !== 13 || b.toString('ascii', 12, 16) !== 'IHDR')
            throw fail(415, 'Invalid PNG');
        width = b.readUInt32BE(16);
        height = b.readUInt32BE(20);
        mimeType = 'image/png';
        let end = false;
        for (let i = 8; i + 12 <= b.length;) {
            const n = b.readUInt32BE(i), type = b.toString('ascii', i + 4, i + 8);
            if (n > b.length - i - 12)
                throw fail(415, 'Invalid PNG');
            if (type === 'acTL')
                throw fail(415, 'Animated images are not supported');
            i += n + 12;
            if (type === 'IEND') {
                end = n === 0 && i === b.length;
                break;
            }
        }
        if (!end)
            throw fail(415, 'Incomplete PNG');
    }
    else if (b.length > 4 && b[0] === 255 && b[1] === 216 && b[b.length - 2] === 255 && b[b.length - 1] === 217) {
        mimeType = 'image/jpeg';
        let i = 2;
        while (i < b.length - 2) {
            if (b[i++] !== 255)
                throw fail(415, 'Invalid JPEG');
            while (b[i] === 255)
                i++;
            const marker = b[i++];
            if (marker === 0xda || marker === 0xd9)
                break;
            if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7))
                continue;
            if (i + 2 > b.length)
                break;
            const n = b.readUInt16BE(i);
            if (n < 2 || i + n > b.length)
                throw fail(415, 'Invalid JPEG');
            if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
                if (n < 8)
                    throw fail(415, 'Invalid JPEG');
                height = b.readUInt16BE(i + 3);
                width = b.readUInt16BE(i + 5);
                break;
            }
            i += n;
        }
    }
    else if (b.length >= 26 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' && b.readUInt32LE(4) === b.length - 8) {
        mimeType = 'image/webp';
        const type = b.toString('ascii', 12, 16);
        if (type === 'VP8X' && b.length >= 30 && b.readUInt32LE(16) === 10) {
            if (b[20]! & 2)
                throw fail(415, 'Animated images are not supported');
            width = 1 + b.readUIntLE(24, 3);
            height = 1 + b.readUIntLE(27, 3);
        }
        else if (type === 'VP8 ' && b.length >= 30 && b[23] === 0x9d && b[24] === 1 && b[25] === 0x2a) {
            width = b.readUInt16LE(26) & 0x3fff;
            height = b.readUInt16LE(28) & 0x3fff;
        }
        else if (type === 'VP8L' && b[20] === 0x2f) {
            const bits = b.readUInt32LE(21);
            width = 1 + (bits & 0x3fff);
            height = 1 + ((bits >>> 14) & 0x3fff);
        }
        let pixel = false, i = 12;
        for (; i + 8 <= b.length;) {
            const n = b.readUInt32LE(i + 4), kind = b.toString('ascii', i, i + 4);
            if (n > b.length - i - 8)
                throw fail(415, 'Invalid WebP');
            if (kind === 'ANIM' || kind === 'ANMF')
                throw fail(415, 'Animated images are not supported');
            if (kind === 'VP8 ' || kind === 'VP8L')
                pixel = true;
            i += 8 + n + (n % 2);
            if (i > b.length)
                throw fail(415, 'Invalid WebP');
        }
        if (!pixel || i !== b.length)
            throw fail(415, 'Invalid WebP');
    }
    if (!mimeType || !width || !height || width > 16384 || height > 16384 || width * height > 32000000)
        throw fail(415, 'Use a PNG, JPEG or WebP image up to 32 megapixels');
    return { mimeType, width, height };
}
export class ImageResources {
    private tails = new Map<string, Promise<unknown>>();
    constructor(private directory: string) { }
    private dir(session: string) { if (!sessionRE.test(session))
        throw fail(400, 'Invalid conversation'); return path.join(this.directory, session); }
    private async serial<T>(session: string, run: () => Promise<T>): Promise<T> { const prior = this.tails.get(session) ?? Promise.resolve(); const task = prior.catch(() => { }).then(run); this.tails.set(session, task); try {
        return await task;
    }
    finally {
        if (this.tails.get(session) === task)
            this.tails.delete(session);
    } }
    bind(session: string, current: () => string): ImageResourceAccess {
        this.dir(session);
        return { publish: (requested, signal) => this.serial(session, async () => {
                const cwd = current();
                const check = () => { signal?.throwIfAborted(); if (current() !== cwd)
                    throw fail(409, 'Conversation directory changed'); };
                check();
                if (typeof requested !== 'string' || requested.length > 8192)
                    throw fail(400, 'Invalid image path');
                const opened = await openArtifact(cwd, requested);
                let bytes: Buffer;
                try {
                    if (opened.stat.size < 1 || opened.stat.size > IMAGE_LIMIT)
                        throw fail(413, 'Image exceeds 8 MiB');
                    bytes = Buffer.alloc(opened.stat.size);
                    let offset = 0;
                    while (offset < bytes.length) {
                        check();
                        const r = await opened.file.read(bytes, offset, bytes.length - offset, offset);
                        if (!r.bytesRead)
                            throw fail(409, 'Image changed while reading');
                        offset += r.bytesRead;
                    }
                    const after = await opened.file.stat();
                    if (after.size !== opened.stat.size || after.mtimeMs !== opened.stat.mtimeMs || after.ctimeMs !== opened.stat.ctimeMs || await fs.realpath(opened.candidate) !== opened.resolved)
                        throw fail(409, 'Image changed while reading');
                }
                finally {
                    await opened.file.close();
                }
                check();
                const shape = inspectImage(bytes);
                const id = createHash('sha256').update(bytes).digest('hex');
                const dir = this.dir(session);
                await fs.mkdir(dir, { recursive: true, mode: 0o700 });
                check();
                const ref = `ashub-image:${id}/${shape.width}x${shape.height}`;
                try {
                    const existing = await this.metadata(session, id);
                    check();
                    return { ...existing, ref };
                }
                catch (e: any) {
                    if (e.code !== 'ENOENT')
                        throw e;
                }
                const names = (await fs.readdir(dir)).filter(n => idRE.test(n));
                const sizes = await Promise.all(names.map(n => fs.stat(path.join(dir, n))));
                if (names.length >= SESSION_COUNT || sizes.reduce((a, s) => a + s.size, 0) + bytes.length > SESSION_BYTES)
                    throw fail(413, 'Conversation image storage is full');
                const meta: ImageMetadata = { id, ...shape, size: bytes.length, name: 'image.' + ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[shape.mimeType]) };
                const temp = path.join(dir, `.${randomUUID()}`);
                let saved = false;
                try {
                    await fs.writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
                    check();
                    await fs.rename(temp, path.join(dir, id));
                    saved = true;
                    await fs.writeFile(temp, JSON.stringify(meta), { flag: 'wx', mode: 0o600 });
                    check();
                    await fs.rename(temp, path.join(dir, id + '.json'));
                    check();
                    return { ...meta, ref };
                }
                catch (e) {
                    if (saved) {
                        await fs.rm(path.join(dir, id), { force: true });
                        await fs.rm(path.join(dir, id + '.json'), { force: true });
                    }
                    throw e;
                }
                finally {
                    await fs.rm(temp, { force: true });
                }
            }) };
    }
    async metadata(session: string, id: string): Promise<ImageMetadata> {
        if (!idRE.test(id))
            throw fail(400, 'Invalid image resource');
        const dir = this.dir(session);
        const opened = await openArtifact(dir, id + '.json');
        let meta: ImageMetadata;
        try {
            if (opened.stat.size > 2048)
                throw fail(404, 'Invalid image metadata');
            meta = JSON.parse(await opened.file.readFile('utf8'));
        }
        finally {
            await opened.file.close();
        }
        if (meta.id !== id || !['image/png', 'image/jpeg', 'image/webp'].includes(meta.mimeType) || !Number.isInteger(meta.size) || meta.size < 1 || meta.size > IMAGE_LIMIT || !Number.isInteger(meta.width) || !Number.isInteger(meta.height) || meta.width < 1 || meta.height < 1 || meta.width > 16384 || meta.height > 16384 || meta.width * meta.height > 32000000)
            throw fail(404, 'Invalid image metadata');
        return { ...meta, name: 'image.' + ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[meta.mimeType]) };
    }
    async read(session: string, id: string, offset = 0) {
        const meta = await this.metadata(session, id);
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > meta.size)
            throw fail(400, 'Invalid image offset');
        const opened = await openArtifact(this.dir(session), id);
        try {
            if (opened.stat.size !== meta.size)
                throw fail(409, 'Image snapshot changed');
            const data = Buffer.alloc(Math.min(256 * 1024, meta.size - offset));
            let used = 0;
            while (used < data.length) {
                const r = await opened.file.read(data, used, data.length - used, offset + used);
                if (!r.bytesRead)
                    throw fail(409, 'Image snapshot changed');
                used += r.bytesRead;
            }
            return { data: data.toString('base64'), nextOffset: offset + used, size: meta.size, version: id };
        }
        finally {
            await opened.file.close();
        }
    }
    async remove(session: string) { await this.serial(session, () => fs.rm(this.dir(session), { recursive: true, force: true })); }
    async serve(req: IncomingMessage, res: ServerResponse, session: string, id: string, current: () => unknown) {
        try {
            current();
            const meta = await this.metadata(session, id);
            current();
            const url = new URL(req.url!, 'http://localhost');
            if (url.searchParams.has('version') && url.searchParams.get('version') !== id)
                throw fail(409, 'Image version mismatch');
            if (url.searchParams.has('meta') || url.searchParams.has('offset')) {
                const result = url.searchParams.has('offset') ? await this.read(session, id, Number(url.searchParams.get('offset'))) : { ...meta, version: id };
                current();
                res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
                res.end(JSON.stringify(result));
                return;
            }
            res.writeHead(200, { 'Content-Type': meta.mimeType, 'Content-Length': meta.size, 'Content-Disposition': `attachment; filename="${meta.name}"`, 'X-Artifact-Version': id, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'X-Image-Width': String(meta.width), 'X-Image-Height': String(meta.height) });
            if (req.method === 'HEAD') {
                res.end();
                return;
            }
            for (let offset = 0; offset < meta.size;) {
                const chunk = await this.read(session, id, offset);
                current();
                if (res.destroyed)
                    return;
                offset = chunk.nextOffset;
                if (!res.write(Buffer.from(chunk.data, 'base64')))
                    await new Promise<void>(resolve => { const done = () => { res.off('drain', done); res.off('close', done); resolve(); }; res.once('drain', done); res.once('close', done); });
            }
            res.end();
        }
        catch (e: any) {
            if (res.headersSent) {
                res.destroy();
                return;
            }
            res.writeHead(e.status ?? 404, { 'Cache-Control': 'no-store' });
            res.end('Image unavailable');
        }
    }
}
