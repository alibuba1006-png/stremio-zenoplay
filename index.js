const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const express = require('express');
const iconv = require('iconv-lite');

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0";
const BASE_URL = "https://zenoplay.to";

const manifest = {
    id: 'org.zenoplay.proxy',
    version: '1.6.0',
    name: 'ZenoPlay Direct Proxy',
    description: 'Stremio addon with strictly single source and decrypted subtitles support',
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
    // КЛЮЧОВО: 'subtitles' е добавен тук!
    resources: ['catalog', 'meta', 'stream', 'subtitles'],
    idPrefixes: ['zeno_']
};

const builder = new addonBuilder(manifest);
const app = express();

app.use(express.json());
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    next();
});

process.on('uncaughtException', (err) => {
    console.error('[CRITICAL UNCAUGHT EXCEPTION]:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[CRITICAL UNHANDLED REJECTION]:', reason);
});

// 1. Каталог
builder.defineCatalogHandler(async ({ type, id, extra }) => {
    try {
        console.log(`[CATALOG] Заявка за каталог type: ${type}, skip: ${extra?.skip || 0}, search: ${extra?.search || 'none'}`);
        let url = `${BASE_URL}/movies/`;
        if (type === 'series') {
            url = `${BASE_URL}/tv-shows/`;
        }
        
        if (extra && extra.search) {
            url = `${BASE_URL}/?s=${encodeURIComponent(extra.search)}`;
        } else if (extra && extra.skip && extra.skip > 0) {
            const page = Math.floor(extra.skip / 20) + 1;
            if (page > 1) {
                url = `${url}page/${page}/`;
            }
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
                const itemType = isSeriesItem ? 'series' : 'movie';

                if (itemType === type) {
                    const zenoId = 'zeno_' + Buffer.from(link).toString('base64').replace(/=/g, '');
                    metas.push({
                        id: zenoId,
                        type: type,
                        name: title || 'Без заглавие',
                        poster: cover && cover.startsWith('//') ? 'https:' + cover : cover
                    });
                }
            }
        });

        console.log(`[CATALOG] Успешно намерени ${metas.length} елемента.`);
        return { metas };
    } catch (e) {
        console.error(`[CATALOG ERROR]:`, e.message);
        return { metas: [] };
    }
});

// 2. Мета данни
builder.defineMetaHandler(async ({ type, id }) => {
    try {
        console.log(`[META] Заявка за метаданни ID: ${id}`);
        const encodedPath = id.replace('zeno_', '');
        const pageLink = Buffer.from(encodedPath, 'base64').toString('utf8');
        const url = pageLink.startsWith('http') ? pageLink : BASE_URL + pageLink;

        const response = await axios.get(url, { headers: { 'User-Agent': UA } });
        const $ = cheerio.load(response.data);

        const title = $('h1').first().text().trim() || "Заглавие";
        const poster = $('meta[property="og:image"]').attr('content') || "";
        const description = $('.description p').first().text().trim() || "";

        const meta = {
            id: id,
            type: type,
            name: title,
            poster: poster,
            description: description,
            genres: []
        };

        if (type === 'series') {
            const videos = [];
            
            $('.episodess a, .les-episod a, .seasons-dropdown a, .episode-item a, ul.episodess li a, .e-item a, .les-m a, .numeros a').each((i, el) => {
                const epLink = $(el).attr('href');
                let epThumbnail = $(el).find('img').attr('src') || $(el).attr('data-img') || poster;
                if (epThumbnail && epThumbnail.startsWith('//')) epThumbnail = 'https:' + epThumbnail;

                let epTitle = $(el).text().replace(/play_circle/gi, '').trim();
                if (!epTitle) epTitle = `Епизод ${i + 1}`;

                let seasonNum = 1;
                let episodeNum = i + 1;

                const seasonMatch = epTitle.match(/(?:сезон|season|c)\s*(\d+)/i) || epLink.match(/season[/-](\d+)/i);
                const epMatch = epTitle.match(/(?:епизод|ep|e)\s*(\d+)/i) || epLink.match(/episode[/-](\d+)/i);

                if (seasonMatch) seasonNum = parseInt(seasonMatch[1], 10);
                if (epMatch) episodeNum = parseInt(epMatch[1], 10);
                
                if (epLink) {
                    videos.push({
                        id: id + ':' + Buffer.from(epLink).toString('base64').replace(/=/g, ''),
                        title: epTitle,
                        season: seasonNum,
                        episode: episodeNum,
                        thumbnail: epThumbnail
                    });
                }
            });

            if (videos.length === 0) {
                $('a').each((i, el) => {
                    const href = $(el).attr('href');
                    let text = $(el).text().replace(/play_circle/gi, '').trim();
                    let epThumbnail = $(el).find('img').attr('src') || poster;
                    if (epThumbnail && epThumbnail.startsWith('//')) epThumbnail = 'https:' + epThumbnail;

                    if (href && (href.includes('/episode/') || href.includes('/tv-episode/') || href.includes('epizod') || text.toLowerCase().includes('епизод'))) {
                        videos.push({
                            id: id + ':' + Buffer.from(href).toString('base64').replace(/=/g, ''),
                            title: text || `Епизод ${videos.length + 1}`,
                            season: 1,
                            episode: videos.length + 1,
                            thumbnail: epThumbnail
                        });
                    }
                });
            }

            if (videos.length > 0) {
                meta.videos = videos;
            }
        }

        console.log(`[META] Успешно заглавие: "${title}" (Епизоди: ${meta.videos ? meta.videos.length : 0})`);
        return { meta };
    } catch (e) {
        console.error(`[META ERROR]:`, e.message);
        return { meta: { id, type, name: "Грешка при зареждане" } };
    }
});

// Извличане на субтитри
async function fetchSubtitlesForId(id, req) {
    let pageLink = '';
    if (id.includes(':')) {
        const parts = id.split(':');
        pageLink = Buffer.from(parts[1], 'base64').toString('utf8');
    } else {
        const encodedPath = id.replace('zeno_', '');
        pageLink = Buffer.from(encodedPath, 'base64').toString('utf8');
    }

    const url = pageLink.startsWith('http') ? pageLink : BASE_URL + pageLink;
    const response = await axios.get(url, { headers: { 'User-Agent': UA } });
    const $ = cheerio.load(response.data);

    let playerUrl = '';
    $('button[data-url], a[data-url], div[data-url], iframe, .player-item').each((i, el) => {
        const dataUrl = $(el).attr('data-url') || $(el).attr('data-link') || $(el).attr('data-src') || $(el).attr('src') || $(el).attr('href');
        if (dataUrl && !playerUrl) {
            const normalized = dataUrl.startsWith('//') ? 'https:' + dataUrl : dataUrl;
            if (normalized.includes('ruplayer.org') || normalized.includes('vidplayer.su')) {
                playerUrl = normalized;
            }
        }
    });

    if (!playerUrl) return [];

    const subs = [];
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
                const encodedSubUrl = Buffer.from(subUrl).toString('base64').replace(/=/g, '');
                const proxiedSubUrl = `${protocol}://${host}/subtitles/${encodedSubUrl}/sub.vtt`;

                subs.push({
                    id: `sub_${index}`,
                    url: proxiedSubUrl,
                    lang: langCode,
                    label: langLabel
                });
            }
        });
    }
    return subs;
}

// 3. Subtitles Handler за Stremio
builder.defineSubtitlesHandler(async ({ type, id }, req) => {
    try {
        console.log(`[SDK SUBTITLES HANDLER] Заявка за субтитри ID: ${id}`);
        const subtitles = await fetchSubtitlesForId(id, req);
        console.log(`[SDK SUBTITLES HANDLER] Намерени субтитри: ${subtitles.length}`);
        return { subtitles };
    } catch (e) {
        console.error(`[SDK SUBTITLES HANDLER ERROR]:`, e.message);
        return { subtitles: [] };
    }
});

// 4. Stream Handler
builder.defineStreamHandler(async ({ type, id }, req) => {
    try {
        console.log(`[STREAM] Заявка за стрийм ID: ${id}`);
        let pageLink = '';
        
        if (id.includes(':')) {
            const parts = id.split(':');
            pageLink = Buffer.from(parts[1], 'base64').toString('utf8');
        } else {
            const encodedPath = id.replace('zeno_', '');
            pageLink = Buffer.from(encodedPath, 'base64').toString('utf8');
        }

        const url = pageLink.startsWith('http') ? pageLink : BASE_URL + pageLink;
        const response = await axios.get(url, { headers: { 'User-Agent': UA } });
        const $ = cheerio.load(response.data);

        const foundPlayers = [];

        $('button[data-url], a[data-url], div[data-url], iframe, .player-item').each((i, el) => {
            const dataUrl = $(el).attr('data-url') || $(el).attr('data-link') || $(el).attr('data-src') || $(el).attr('src') || $(el).attr('href');
            const btnText = $(el).text().trim() || $(el).attr('title') || `Плеър ${i + 1}`;
            
            if (dataUrl) {
                const normalizedUrl = dataUrl.startsWith('//') ? 'https:' + dataUrl : dataUrl;
                
                if (
                    !normalizedUrl.includes('morencius.com') &&
                    (normalizedUrl.includes('ruplayer.org') ||
                     normalizedUrl.includes('vidplayer.su') ||
                     normalizedUrl.includes('vidsrc') ||
                     normalizedUrl.includes('embed') ||
                     normalizedUrl.includes('.m3u8'))
                ) {
                    if (!foundPlayers.some(p => p.url === normalizedUrl)) {
                        foundPlayers.push({
                            title: btnText.replace(/play_circle/gi, '').trim() || `Плеър ${foundPlayers.length + 1}`,
                            url: normalizedUrl
                        });
                    }
                }
            }
        });

        const singlePlayer = foundPlayers.slice(0, 1);
        const streams = [];

        // Взимаме субтитрите за вграждане в stream обекта
        const subtitles = await fetchSubtitlesForId(id, req);

        for (const player of singlePlayer) {
            const playerTitle = player.title;
            const playerUrl = player.url;

            if (playerUrl.includes('ruplayer.org') || playerUrl.includes('vidplayer.su')) {
                const domainMatch = playerUrl.match(/https?:\/\/([^\/]+)/);
                const domain = domainMatch ? domainMatch[1] : 'ruplayer.org';
                
                let hash = '';
                if (playerUrl.includes('/video/')) {
                    hash = playerUrl.split('/video/')[1];
                } else if (playerUrl.includes('/m3/')) {
                    hash = playerUrl.split('/m3/')[1];
                }

                if (hash) {
                    try {
                        const postUrl = `https://${domain}/player/index.php?data=${hash}&do=getVideo`;
                        const postRes = await axios.post(postUrl, `hash=${hash}&r=${encodeURIComponent(BASE_URL + '/')}`, {
                            headers: {
                                'User-Agent': UA,
                                'Origin': `https://${domain}`,
                                'Referer': playerUrl,
                                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                                'X-Requested-With': 'XMLHttpRequest'
                            },
                            timeout: 3000
                        });

                        if (postRes.data && postRes.data.securedLink) {
                            const targetMasterUrl = postRes.data.securedLink;
                            const host = req ? req.headers['host'] : process.env.RENDER_EXTERNAL_URL ? new URL(process.env.RENDER_EXTERNAL_URL).host : 'localhost:10000';
                            const protocol = req && req.headers['x-forwarded-proto'] ? req.headers['x-forwarded-proto'] : 'https';

                            const proxyUrl = `${protocol}://${host}/proxy?url=${encodeURIComponent(targetMasterUrl)}&domain=${domain}&referer=${encodeURIComponent(playerUrl)}`;

                            streams.push({
                                title: `ZenoPlay - ${playerTitle} (Proxy)`,
                                url: proxyUrl,
                                subtitles: subtitles
                            });
                        } else {
                            streams.push({
                                title: `ZenoPlay - ${playerTitle} (Web)`,
                                url: playerUrl,
                                subtitles: subtitles
                            });
                        }
                    } catch (err) {
                        streams.push({
                            title: `ZenoPlay - ${playerTitle} (Web)`,
                            url: playerUrl,
                            subtitles: subtitles
                        });
                    }
                }
            } else {
                streams.push({
                    title: `ZenoPlay - ${playerTitle} (Web)`,
                    url: playerUrl,
                    subtitles: subtitles
                });
            }
        }

        return { streams };
    } catch (e) {
        console.error(`[STREAM HANDLER ERROR]:`, e.message);
        return { streams: [] };
    }
});

app.use(getRouter(builder.getInterface()));

// 5. Прокси за видео сегменти
app.get('/proxy', async (req, res) => {
    const targetUrl = req.query.url;
    const domain = req.query.domain || 'ruplayer.org';
    const referer = req.query.referer || `https://${domain}/`;

    if (!targetUrl) return res.status(400).send('Missing url parameter');

    try {
        const response = await axios.get(targetUrl, {
            headers: { 'User-Agent': UA, 'Referer': referer, 'Origin': `https://${domain}` },
            responseType: targetUrl.includes('.m3u8') || targetUrl.includes('playlist') ? 'text' : 'stream'
        });

        res.setHeader('Access-Control-Allow-Origin', '*');

        const contentType = response.headers['content-type'] || '';
        if (targetUrl.includes('.m3u8') || contentType.includes('mpegurl') || typeof response.data === 'string') {
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            
            let m3u8Content = response.data;
            const baseUrlObj = new URL(targetUrl);
            const host = req.headers['host'];
            const protocol = req.headers['x-forwarded-proto'] || 'https';

            const modifiedLines = m3u8Content.split('\n').map(line => {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) return line;

                let segmentUrl = trimmed;
                if (!segmentUrl.startsWith('http')) {
                    segmentUrl = new URL(segmentUrl, baseUrlObj.href).toString();
                }

                return `${protocol}://${host}/proxy?url=${encodeURIComponent(segmentUrl)}&domain=${domain}&referer=${encodeURIComponent(referer)}`;
            });

            return res.send(modifiedLines.join('\n'));
        }

        if (response.headers['content-type']) {
            res.setHeader('Content-Type', response.headers['content-type']);
        }
        response.data.pipe(res);

    } catch (error) {
        console.error(`[PROXY ERROR]:`, error.message);
        res.status(500).send('Proxy error');
    }
});

// 6. Прокси за субтитри
app.get('/subtitles/:encodedUrl/*', async (req, res) => {
    try {
        const encodedUrl = req.params.encodedUrl;
        
        let base64 = encodedUrl;
        while (base64.length % 4 !== 0) {
            base64 += '=';
        }

        const subUrl = Buffer.from(base64, 'base64').toString('utf8');
        console.log(`[SUBTITLES REQUEST] Заявка за субтитри от Stremio -> ${subUrl}`);

        const response = await axios.get(subUrl, {
            headers: { 
                'User-Agent': UA, 
                'Referer': 'https://ruplayer.org/' 
            },
            responseType: 'arraybuffer',
            timeout: 8000
        });

        let rawData = iconv.decode(Buffer.from(response.data), 'utf-8');

        let cleanText = rawData.replace(/^(WEBVTT|VTT)\r?\n?/i, '').trim();
        let vttFormat = cleanText.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');

        let lines = vttFormat.split(/\r?\n/);
        let validLines = [];
        let lastWasEmpty = false;

        for (let line of lines) {
            let trimmed = line.trim();
            if (/^\d+$/.test(trimmed)) continue;

            if (trimmed === '') {
                if (!lastWasEmpty) {
                    validLines.push('');
                    lastWasEmpty = true;
                }
            } else {
                validLines.push(trimmed);
                lastWasEmpty = false;
            }
        }

        const finalVtt = `WEBVTT\n\n${validLines.join('\n').trim()}`;

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
        res.send(finalVtt);

        console.log(`[SUBTITLES SUCCESS] Успешно изпратени субтитри към Stremio.`);

    } catch (error) {
        console.error(`[SUBTITLES ERROR]:`, error.message);
        res.status(500).send('Subtitles Error');
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`====================================================`);
    console.log(` ZenoPlay Addon & Proxy активни на порт: ${PORT}`);
    console.log(`====================================================`);
});
