const express = require('express');
const axios = require('axios');
const iconv = require('iconv-lite');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 10000;

const BASE_URL = 'https://filmisub.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0';

// CORS за Stremio
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    next();
});

// Декриптиране на PlayerJS
function decryptPlayerJS(trashString) {
    try {
        if (!trashString || typeof trashString !== 'string') return '';
        if (trashString.startsWith('WEBVTT') || trashString.includes('-->')) return trashString;

        let clean = trashString.replace(/^#2/g, '').replace(/^#1/g, '');

        const key = Buffer.from("bk488x9919k120ks", "utf-8");
        const iv = Buffer.from("1234567890123456", "utf-8");

        const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
        let decrypted = decipher.update(clean, 'base64', 'utf-8');
        decrypted += decipher.final('utf-8');

        return decrypted || trashString;
    } catch (e) {
        return trashString;
    }
}

// Извличане на субтитри от плеъра
async function extractSubtitles(playerUrl, req) {
    const subs = [];
    try {
        const playerRes = await axios.get(playerUrl, {
            headers: { 'User-Agent': UA, 'Referer': `${BASE_URL}/` },
            timeout: 4000
        });

        const html = playerRes.data;
        const match = html.match(/playerjsSubtitle\s*=\s*(['"])([^'"]+)\1/);

        if (match && match[2]) {
            const rawSubs = match[2];
            const parts = rawSubs.split(',');
            const host = req ? req.headers['host'] : process.env.RENDER_EXTERNAL_URL ? new URL(process.env.RENDER_EXTERNAL_URL).host : 'localhost:10000';
            const protocol = req && req.headers['x-forwarded-proto'] ? req.headers['x-forwarded-proto'] : 'https';

            parts.forEach((subPart, index) => {
                const langMatch = subPart.match(/\[([^\]]+)\](.*)/);
                let subUrl = langMatch ? langMatch[2].trim() : subPart.trim();
                let langLabel = langMatch ? langMatch[1].trim() : 'Bulgarian';

                let langCode = 'bg';
                if (langLabel.toLowerCase().includes('eng')) langCode = 'en';

                if (subUrl) {
                    const proxiedSubUrl = `${protocol}://${host}/subtitles?url=${encodeURIComponent(subUrl)}&referer=${encodeURIComponent(playerUrl)}`;
                    subs.push({
                        id: `sub_${index}`,
                        url: proxiedSubUrl,
                        lang: langCode,
                        label: langLabel
                    });
                }
            });
        }
    } catch (err) {
        console.error(`[SUBTITLES ERROR]:`, err.message);
    }
    return subs;
}

// Manifest
app.get('/manifest.json', (req, res) => {
    res.json({
        id: 'org.filmisub.stremio',
        version: '1.0.0',
        name: 'FilmiSub',
        description: 'Гледайте филми и сериали от FilmiSub.com с български субтитри.',
        resources: ['catalog', 'meta', 'stream'],
        types: ['movie', 'series'],
        idPrefixes: ['tt', 'fs_'],
        catalogs: [
            { type: 'movie', id: 'filmisub_movies', name: 'FilmiSub Филми' },
            { type: 'series', id: 'filmisub_series', name: 'FilmiSub Сериали' }
        ]
    });
});

// Catalog
app.get('/catalog/:type/:id.json', async (req, res) => {
    const { type, id } = req.params;
    let categoryPath = type === 'movie' ? '/filmi/' : '/seriali/';

    try {
        const response = await axios.get(`${BASE_URL}${categoryPath}`, {
            headers: { 'User-Agent': UA }
        });

        const html = response.data;
        const metas = [];
        const regex = /<a\s+href="([^"]+)"[^>]*title="([^"]+)"[\s\S]*?<img\s+src="([^"]+)"/g;
        let match;

        while ((match = regex.exec(html)) !== null) {
            const pageUrl = match[1];
            const title = match[2];
            const poster = match[3].startsWith('http') ? match[3] : `${BASE_URL}${match[3]}`;
            const slug = pageUrl.replace(BASE_URL, '').replace(/^\//, '').replace(/\/$/, '');

            metas.push({
                id: `fs_${slug}`,
                type: type,
                name: title,
                poster: poster
            });
        }

        res.json({ metas });
    } catch (err) {
        res.json({ metas: [] });
    }
});

// Meta
app.get('/meta/:type/:id.json', async (req, res) => {
    const { id, type } = req.params;
    let slug = id.replace('fs_', '');
    let pageUrl = `${BASE_URL}/${slug}/`;

    try {
        const response = await axios.get(pageUrl, {
            headers: { 'User-Agent': UA }
        });
        const html = response.data;

        const titleMatch = html.match(/<h1[^>]*>(.*?)<\/h1>/i);
        const posterMatch = html.match(/<img[^>]+src="([^"]+)"[^>]+class="[^"]*poster[^"]*"/i) || html.match(/<img[^>]+src="([^"]+)"/i);

        const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : slug;
        const poster = posterMatch ? (posterMatch[1].startsWith('http') ? posterMatch[1] : `${BASE_URL}${posterMatch[1]}`) : '';

        res.json({
            meta: {
                id: id,
                type: type,
                name: title,
                poster: poster,
                description: 'Преглед от FilmiSub'
            }
        });
    } catch (err) {
        res.json({ meta: { id, type, name: slug } });
    }
});

// Streams
app.get('/stream/:type/:id.json', async (req, res) => {
    const { id } = req.params;
    let slug = id.replace('fs_', '');
    let pageUrl = `${BASE_URL}/${slug}/`;

    try {
        const response = await axios.get(pageUrl, {
            headers: { 'User-Agent': UA }
        });
        const html = response.data;

        const iframeMatches = [...html.matchAll(/<iframe[^>]+src="([^"]+)"/gi)];
        const streams = [];

        for (const m of iframeMatches) {
            let iframeUrl = m[1];
            if (iframeUrl.startsWith('//')) iframeUrl = 'https:' + iframeUrl;

            if (iframeUrl.includes('ruplayer') || iframeUrl.includes('player')) {
                const subtitles = await extractSubtitles(iframeUrl, req);

                streams.push({
                    title: 'FilmiSub Stream (BG Subs)',
                    url: iframeUrl,
                    subtitles: subtitles
                });
            }
        }

        res.json({ streams });
    } catch (err) {
        res.json({ streams: [] });
    }
});

// Subtitles Proxy (Конвертиране на SRT към WEBVTT)
app.get('/subtitles', async (req, res) => {
    const subUrl = req.query.url;
    const referer = req.query.referer || 'https://ruplayer.org/';
    if (!subUrl) return res.status(400).send('Missing url parameter');

    try {
        const response = await axios.get(subUrl, {
            headers: { 'User-Agent': UA, 'Referer': referer },
            responseType: 'arraybuffer',
            timeout: 7000
        });

        let rawText = iconv.decode(Buffer.from(response.data), 'utf-8').trim();

        if (rawText.includes('<html') || rawText.includes('<script')) {
            const scriptMatch = rawText.match(/var\s+trash\s*=\s*['"]([^'"]+)['"]/i) || 
                                rawText.match(/['"](#2[^'"]+)['"]/i) ||
                                rawText.match(/['"](#1[^'"]+)['"]/i);
            if (scriptMatch && scriptMatch[1]) {
                rawText = decryptPlayerJS(scriptMatch[1]);
            }
        }

        // Премахваме съществуващи WEBVTT/VTT маркировки
        rawText = rawText.replace(/^(WEBVTT|VTT)\r?\n?/i, '').trim();

        // Преобразуваме запетаите от SRT таймкодовете в точки за WEBVTT
        let vttContent = rawText.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');

        const finalVtt = `WEBVTT\n\n${vttContent}`;

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
        res.send(finalVtt);

    } catch (error) {
        console.error(`[SUBTITLES PROXY ERROR]:`, error.message);
        res.status(500).send('Subtitles Proxy Error');
    }
});

app.listen(PORT, () => {
    console.log(`Сървърът е стартиран на порт ${PORT}`);
});
