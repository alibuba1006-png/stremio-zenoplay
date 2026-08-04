const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const express = require('express');

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36";
const BASE_URL = "https://zenoplay.to";

const manifest = {
    id: 'org.zenoplay.proxy',
    version: '1.5.0',
    name: 'ZenoPlay Direct Proxy',
    description: 'Stremio addon с пълна поддръжка на субтитри от външни плеъри',
    types: ['movie', 'series'],
    catalogs: [
        {
            type: 'movie',
            id: 'zenoplay_movies',
            name: 'ZenoPlay Филми',
            extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }]
        },
        {
            type: 'series',
            id: 'zenoplay_series',
            name: 'ZenoPlay Сериали',
            extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }]
        }
    ],
    resources: ['catalog', 'meta', 'stream'], // премахваме 'subtitles' от тук, ще ги подаваме директно в stream-а
    idPrefixes: ['zeno_']
};

const builder = new addonBuilder(manifest);
const app = express();

app.use(express.json());
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    next();
});

// --- ПОМОЩНИ ФУНКЦИИ ЗА СУБТИТРИ ---

// Функция за парсване на PlayerJS субтитри от типа "[BG]http://...vtt,[EN]http://...vtt"
function parsePlayerJsSubtitles(subStr) {
    const subs = [];
    if (!subStr) return subs;

    // Разделяме по запетая, тъй като може да има няколко езика
    const parts = subStr.split(',');
    
    parts.forEach((part, idx) => {
        // Търсим опционален етикет в скоби [...] и самия линк
        const match = part.match(/(?:\[(.*?)\])?(https?:\/\/[^\s"'<>]+)/);
        if (match) {
            const label = match[1] || 'Bulgarian';
            const url = match[2];
            
            // Определяме кода на езика за Stremio (ISO 639-2)
            let langCode = 'eng';
            const lowerLabel = label.toLowerCase();
            if (lowerLabel.includes('bg') || lowerLabel.includes('бълг')) langCode = 'bul';
            
            subs.push({
                id: `player_sub_${idx}`,
                url: url,
                lang: langCode
            });
        }
    });
    
    return subs;
}

// Функция за извличане на субтитрите чрез сваляне на iframe-а на плеъра
async function fetchIframeSubtitles(iframeUrl) {
    try {
        const res = await axios.get(iframeUrl, { headers: { 'User-Agent': UA, 'Referer': BASE_URL } });
        const html = res.data;
        
        // Търсим `subtitle: "[БГ]линк, [EN]линк"` или `subtitles: "..."` вътре в JS кода на страницата
        const subMatch = html.match(/subtitle\s*:\s*["']([^"']+)["']/i) || html.match(/subtitles\s*:\s*["']([^"']+)["']/i);
        
        if (subMatch && subMatch[1]) {
            return parsePlayerJsSubtitles(subMatch[1]);
        }
    } catch (err) {
        console.error('[SUBTITLES FETCH ERROR]: Неуспешно четене на iframe:', iframeUrl);
    }
    return [];
}

// --- КАТАЛОЗИ И МЕТА (БЕЗ ПРОМЯНА) ---

builder.defineCatalogHandler(async ({ type, id, extra }) => {
    // (Кодът тук остава същият като в предишната версия - работи коректно)
    try {
        let url = `${BASE_URL}/movies/`;
        if (type === 'series') url = `${BASE_URL}/tv-shows/`;
        
        if (extra && extra.search) {
            url = `${BASE_URL}/?s=${encodeURIComponent(extra.search)}`;
        } else if (extra && extra.skip && extra.skip > 0) {
            const page = Math.floor(extra.skip / 20) + 1;
            if (page > 1) url = `${url}page/${page}/`;
        }

        const response = await axios.get(url, { headers: { 'User-Agent': UA } });
        const $ = cheerio.load(response.data);
        const metas = [];

        $('.movie-item').each((_, element) => {
            const link = $(element).find('a').attr('href');
            const cover = $(element).find('img').attr('src');
            const title = $(element).find('.title, .title_c').text().trim();

            if (link) {
                const isSeriesItem = link.includes('/tv-show/') || link.includes('/tv-episode/');
                if ((isSeriesItem ? 'series' : 'movie') === type) {
                    metas.push({
                        id: 'zeno_' + Buffer.from(link).toString('base64').replace(/=/g, ''),
                        type: type,
                        name: title || 'Без заглавие',
                        poster: cover && cover.startsWith('//') ? 'https:' + cover : cover
                    });
                }
            }
        });
        return { metas };
    } catch (e) {
        return { metas: [] };
    }
});

builder.defineMetaHandler(async ({ type, id }) => {
    // (Кодът тук остава същият като в предишната версия - работи коректно)
    try {
        const pageLink = Buffer.from(id.replace('zeno_', ''), 'base64').toString('utf8');
        const url = pageLink.startsWith('http') ? pageLink : BASE_URL + pageLink;
        const response = await axios.get(url, { headers: { 'User-Agent': UA } });
        const $ = cheerio.load(response.data);

        const meta = {
            id: id, type: type,
            name: $('h1').first().text().trim() || "Заглавие",
            poster: $('meta[property="og:image"]').attr('content') || "",
            description: $('.description p').first().text().trim() || ""
        };

        if (type === 'series') {
            const videos = [];
            $('.episodess a, .episode-item a, ul.episodess li a').each((i, el) => {
                const epLink = $(el).attr('href');
                let epTitle = $(el).text().replace(/play_circle/gi, '').trim() || `Епизод ${i + 1}`;
                if (epLink) {
                    videos.push({
                        id: id + ':' + Buffer.from(epLink).toString('base64').replace(/=/g, ''),
                        title: epTitle,
                        season: parseInt(epTitle.match(/(?:сезон|season|c)\s*(\d+)/i)?.[1] || 1),
                        episode: parseInt(epTitle.match(/(?:епизод|ep|e)\s*(\d+)/i)?.[1] || (i + 1))
                    });
                }
            });
            if (videos.length > 0) meta.videos = videos;
        }
        return { meta };
    } catch (e) {
        return { meta: { id, type, name: "Грешка" } };
    }
});

// --- СТРИЙМИНГ С АКТИВНО ТЪРСЕНЕ НА СУБТИТРИ ОТ IFRAME ---

builder.defineStreamHandler(async ({ type, id }, req) => {
    try {
        let pageLink = id.includes(':') 
            ? Buffer.from(id.split(':')[1], 'base64').toString('utf8')
            : Buffer.from(id.replace('zeno_', ''), 'base64').toString('utf8');

        const url = pageLink.startsWith('http') ? pageLink : BASE_URL + pageLink;
        const response = await axios.get(url, { headers: { 'User-Agent': UA } });
        const $ = cheerio.load(response.data);

        const foundPlayers = [];
        $('button[data-url], iframe').each((i, el) => {
            let dataUrl = $(el).attr('data-url') || $(el).attr('src');
            if (dataUrl) {
                if (dataUrl.startsWith('//')) dataUrl = 'https:' + dataUrl;
                if (dataUrl.includes('ruplayer.org') || dataUrl.includes('vidplayer.su')) {
                    foundPlayers.push({ title: "ZenoPlay Player", url: dataUrl });
                }
            }
        });

        const streams = [];
        const host = req ? req.headers['host'] : 'localhost:10000';
        const protocol = req && req.headers['x-forwarded-proto'] ? req.headers['x-forwarded-proto'] : 'https';

        if (foundPlayers.length > 0) {
            const playerUrl = foundPlayers[0].url;
            const domain = playerUrl.match(/https?:\/\/([^\/]+)/)[1];
            
            // 1. ВЗИМАМЕ СУБТИТРИТЕ ДИРЕКТНО ОТ IFRAME-а
            const extractedSubtitles = await fetchIframeSubtitles(playerUrl);
            
            // 2. ВЗИМАМЕ ВИДЕОТО
            let hash = playerUrl.includes('/video/') ? playerUrl.split('/video/')[1] : playerUrl.split('/m3/')[1];
            
            if (hash) {
                try {
                    const postRes = await axios.post(`https://${domain}/player/index.php?data=${hash}&do=getVideo`, `hash=${hash}&r=${encodeURIComponent(BASE_URL + '/')}`, {
                        headers: { 'User-Agent': UA, 'Origin': `https://${domain}`, 'Content-Type': 'application/x-www-form-urlencoded' }
                    });

                    if (postRes.data && postRes.data.securedLink) {
                        streams.push({
                            title: `ZenoPlay - Proxy`,
                            url: `${protocol}://${host}/proxy?url=${encodeURIComponent(postRes.data.securedLink)}&domain=${domain}&referer=${encodeURIComponent(playerUrl)}`,
                            subtitles: extractedSubtitles // Прикачваме субтитрите
                        });
                    }
                } catch (e) {
                    console.error('[STREAM POST ERROR]');
                }
            }
            
            // Fallback ако Proxy-то не мине
            streams.push({
                title: `ZenoPlay - Web`,
                url: playerUrl,
                subtitles: extractedSubtitles
            });
        }

        return { streams };
    } catch (e) {
        console.error(`[STREAM HANDLER ERROR]:`, e);
        return { streams: [] };
    }
});

// Интеграция на Stremio
app.use(getRouter(builder.getInterface()));

// Прокси за M3U8
app.get('/proxy', async (req, res) => {
    const { url: targetUrl, domain, referer } = req.query;
    if (!targetUrl) return res.status(400).send('Липсва URL');

    try {
        const response = await axios.get(targetUrl, {
            headers: { 'User-Agent': UA, 'Referer': referer || `https://${domain}/`, 'Origin': `https://${domain}` },
            responseType: targetUrl.includes('.m3u8') ? 'text' : 'stream'
        });

        res.setHeader('Access-Control-Allow-Origin', '*');
        
        if (targetUrl.includes('.m3u8') || typeof response.data === 'string') {
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            const baseUrlObj = new URL(targetUrl);
            
            const modifiedM3u8 = response.data.split('\n').map(line => {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) return line;
                const segmentUrl = trimmed.startsWith('http') ? trimmed : new URL(trimmed, baseUrlObj.href).toString();
                return `${req.protocol}://${req.headers.host}/proxy?url=${encodeURIComponent(segmentUrl)}&domain=${domain}&referer=${encodeURIComponent(referer)}`;
            }).join('\n');
            
            return res.send(modifiedM3u8);
        }
        
        response.data.pipe(res);
    } catch (error) {
        res.status(500).send('Proxy error');
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log(`ZenoPlay Proxy работи на порт: ${PORT}`));
