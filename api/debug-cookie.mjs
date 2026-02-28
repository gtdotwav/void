import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtemp, rm, readFile } from 'fs/promises';
import { buildYoutubeCookiesFile, setCorsHeaders, sendJson } from '../server.mjs';

export const config = {
    maxDuration: 15
};

export default async function handler(req, res) {
    // Security: only allow via specific header
    if (req.headers['x-debug-key'] !== 'jv-debug-2025') {
        sendJson(res, 403, { error: 'Forbidden' });
        return;
    }

    setCorsHeaders(res);

    const tempDir = await mkdtemp(join(tmpdir(), 'jv-cookie-debug-'));
    try {
        const cookiePath = await buildYoutubeCookiesFile(tempDir, '');
        if (!cookiePath) {
            sendJson(res, 200, { hasCookies: false, message: 'No cookies configured' });
            return;
        }

        const raw = await readFile(cookiePath, 'utf8');
        const lines = raw.split('\n');
        const parsedLines = lines.map((line, i) => {
            if (!line || line.startsWith('#')) return { lineNum: i + 1, type: 'comment', raw: line };
            const parts = line.split('\t');
            return {
                lineNum: i + 1,
                type: 'cookie',
                partCount: parts.length,
                domain: parts[0],
                name: parts[5] || '?',
                valueLength: (parts[6] || '').length,
                valueSample: (parts[6] || '').slice(0, 20),
                hasControlChars: /[\x00-\x08\x0b-\x1f\x7f]/.test(line)
            };
        });
        sendJson(res, 200, { hasCookies: true, lineCount: lines.length, lines: parsedLines });
    } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => { });
    }
}
