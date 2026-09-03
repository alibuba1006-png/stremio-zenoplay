const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const express = require('express');

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0";
const BASE_URL = "https://zenoplay.to";

const manifest = {
    id: 'org.zenoplay.proxy',
    version: '1.4.2',
    name: 'ZenoPlay Direct Proxy',
    description: 'Stremio addon with working proxied subtitles',
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
    resources: ['catalog', 'meta', 'stream'],
    idPrefixes: ['zeno_']
};

const builder = new addonBuilder(manifest);
const app = express();

app.use(express.json());
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    next();
});

// 1. Каталог
builder.defineCatalogHandler(async ({ type, id, extra }) => {
    try {
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

        $('.movie-item, .item, .ml-item, article').each((_, element) => {
            const link = $(element).find('a').attr('href');
            const cover = $(element).find('img').attr('src') || $(element).find('img').attr('data-src');
            const title = $(element).find('.title, .title_c, h2, h3').text().trim();

            if (link) {
                const isSeriesItem = link.includes('/tv-show/') || link.includes('/tv-episode/') || link.includes('/series/');
                const itemType = isSeriesItem ? 'series' : 'movie';

                if (itemType === type) {
                    const zenoId = 'zeno_' + Buffer.from(link).toString('base64').replace(/=/g, '');
                    if (!metas.some(m => m.id === zenoId)) {
                        metas.push({
                            id: zenoId,
                            type: type,
                            name: title || 'Без заглавие',
                            poster: cover && cover.startsWith('//') ? 'https:' + cover : cover
                        });
                    }
                }
            }
        });

        return { metas };
    } catch (e) {
        console.error(`[CATALOG ERROR]:`, e);
        return { metas: [] };
    }
});

// 2. Мета данни
builder.defineMetaHandler(async ({ type, id }) => {
    try {
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

            if (videos.length > 0) meta.videos = videos;
        }

        return { meta };
    } catch (e) {
        console.error(`[META ERROR]:`, e);
        return { meta: { id, type, name: "Грешка при зареждане" } };
    }
});

// 3. Стрийминг хендлър с правилни проксирани субтитри
builder.defineStreamHandler(async ({ type, id }, req) => {
    try {
        let pageLink = '';
        if (id.includes(':')) {
            const parts = id.split(':');
            pageLink = Buffer.from(parts[1], 'base64').toString('utf8');
        } else {
            pageLink = Buffer.from(id.replace('zeno_', ''), 'base64').toString('utf8');
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
                if (normalizedUrl.includes('ruplayer.org') || normalizedUrl.includes('vidplayer.su')) {
                    if (!foundPlayers.some(p => p.url === normalizedUrl)) {
                        foundPlayers.push({ title: btnText.replace(/play_circle/gi, '').trim(), url: normalizedUrl });
                    }
                }
            }
        });

        const singlePlayer = foundPlayers.slice(0, 1);
        const streams = [];

        const host = req ? req.headers['host'] : (process.env.RENDER_EXTERNAL_URL ? new URL(process.env.RENDER_EXTERNAL_URL).host : 'localhost:10000');
        const protocol = req && req.headers['x-forwarded-proto'] ? req.headers['x-forwarded-proto'] : 'https';

        for (const player of singlePlayer) {
            const playerUrl = player.url;
            let extractedSubs = [];

            try {
                const playerRes = await axios.get(playerUrl, { headers: { 'User-Agent': UA, 'Referer': `${BASE_URL}/` } });
                const match = playerRes.data.match(/playerjsSubtitle\s*=\s*(['"])([^'"]+)\1/);

                if (match && match[2]) {
                    let subRaw = match[2];
                    const langMatch = subRaw.match(/\[([^\]]+)\](.*)/);
                    let subUrl = langMatch ? langMatch[2] : subRaw;
                    let lang = langMatch ? langMatch[1] : 'Bulgarian';

                    // Добавяме фиктивно разширение към прокси линка, за да го разпознае Stremio като субтитри
                    const proxySubUrl = `${protocol}://${host}/proxy-sub?url=${encodeURIComponent(subUrl)}&file=sub.srt`;

                    extractedSubs.push({
                        id: 'sub_bg',
                        url: proxySubUrl,
                        lang: lang
                    });
                }
            } catch (err) {
                console.error('[SUBTITLE ERROR]:', err.message);
            }

            const domainMatch = playerUrl.match(/https?:\/\/([^\/]+)/);
            const domain = domainMatch ? domainMatch[1] : 'ruplayer.org';
            let hash = playerUrl.includes('/video/') ? playerUrl.split('/video/')[1] : '';

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
                        const proxyUrl = `${protocol}://${host}/proxy?url=${encodeURIComponent(postRes.data.securedLink)}&domain=${domain}&referer=${encodeURIComponent(playerUrl)}`;
                        streams.push({
                            title: `ZenoPlay - ${player.title} (Proxy)`,
                            url: proxyUrl,
                            subtitles: extractedSubs
                        });
                    }
                } catch (e) {
                    streams.push({
                        title: `ZenoPlay - ${player.title} (Web)`,
                        url: playerUrl,
                        subtitles: extractedSubs
                    });
                }
            }
        }

        return { streams };
    } catch (e) {
        return { streams: [] };
    }
});

// Прокси за видео потока
app.get('/proxy', async (req, res) => {
    const targetUrl = req.query.url;
    const domain = req.query.domain || 'ruplayer.org';
    const referer = req.query.referer || `https://${domain}/`;

    if (!targetUrl) return res.status(400).send('Missing url');

    try {
        const response = await axios.get(targetUrl, {
            headers: { 'User-Agent': UA, 'Referer': referer, 'Origin': `https://${domain}` },
            responseType: targetUrl.includes('.m3u8') ? 'text' : 'stream'
        });

        res.setHeader('Access-Control-Allow-Origin', '*');

        if (targetUrl.includes('.m3u8') || typeof response.data === 'string') {
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            const host = req.headers['host'];
            const protocol = req.headers['x-forwarded-proto'] || 'https';
            
            const modified = response.data.split('\n').map(line => {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) return line;
                let segUrl = trimmed.startsWith('http') ? trimmed : new URL(trimmed, targetUrl).toString();
                return `${protocol}://${host}/proxy?url=${encodeURIComponent(segUrl)}&domain=${domain}&referer=${encodeURIComponent(referer)}`;
            });
            return res.send(modified.join('\n'));
        }

        if (response.headers['content-type']) res.setHeader('Content-Type', response.headers['content-type']);
        response.data.pipe(res);
    } catch (err) {
        res.status(500).send('Proxy error');
    }
});

// Поправено прокси за субтитри
app.get('/proxy-sub', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('Missing url');

    try {
        const response = await axios.get(targetUrl, {
            headers: { 
                'User-Agent': UA, 
                'Referer': 'https://ruplayer.org/' 
            }
        });

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send(response.data);
    } catch (err) {
        console.error('[SUB PROXY ERROR]:', err.message);
        res.status(500).send('Sub proxy error');
    }
});

app.use(getRouter(builder.getInterface()));

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Addon & Proxy активни на порт: ${PORT}`);
});
