const { addonBuilder } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const express = require('express');

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
const BASE_URL = "https://zenoplay.to";

const manifest = {
    id: 'org.zenoplay.proxy',
    version: '1.4.4',
    name: 'ZenoPlay Direct',
    description: 'Stremio addon with native proxy headers',
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

        return { metas };
    } catch (e) {
        return { metas: [] };
    }
});

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

            if (videos.length > 0) {
                meta.videos = videos;
            }
        }

        return { meta };
    } catch (e) {
        return { meta: { id, type, name: "Грешка при зареждане" } };
    }
});

builder.defineStreamHandler(async ({ type, id }) => {
    try {
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
        const html = response.data;
        const $ = cheerio.load(html);

        const foundPlayers = [];

        $('button[data-url], a[data-url], div[data-url], iframe, .player-item').each((i, el) => {
            const dataUrl = $(el).attr('data-url') || $(el).attr('data-link') || $(el).attr('data-src') || $(el).attr('src') || $(el).attr('href');
            const btnText = $(el).text().trim() || $(el).attr('title') || `Плеър ${i + 1}`;
            
            if (dataUrl) {
                const normalizedUrl = dataUrl.startsWith('//') ? 'https:' + dataUrl : dataUrl;
                if (
                    normalizedUrl.includes('morencius.com') ||
                    normalizedUrl.includes('ruplayer.org') ||
                    normalizedUrl.includes('vidplayer.su') ||
                    normalizedUrl.includes('vidsrc') ||
                    normalizedUrl.includes('embed') ||
                    normalizedUrl.includes('.m3u8')
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

        const streams = [];

        for (const player of foundPlayers) {
            const playerTitle = player.title;
            const playerUrl = player.url;

            // Логика за Morencius (Вторият плеър)
            if (playerUrl.includes('morencius.com') || playerUrl.includes('.m3u8')) {
                const domainMatch = playerUrl.match(/https?:\/\/([^\/]+)/);
                const domain = domainMatch ? domainMatch[1] : 'morencius.com';
                
                streams.push({
                    title: `ZenoPlay - ${playerTitle} (Direct)`,
                    url: playerUrl,
                    behaviorHints: {
                        notWebReady: true,
                        proxyHeaders: {
                            request: {
                                "User-Agent": UA,
                                "Referer": playerUrl,
                                "Origin": `https://${domain}`
                            }
                        }
                    }
                });
            } 
            // Логика за Ruplayer (Първият плеър)
            else if (playerUrl.includes('ruplayer.org') || playerUrl.includes('vidplayer.su')) {
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
                            timeout: 4000
                        });

                        if (postRes.data && postRes.data.securedLink) {
                            streams.push({
                                title: `ZenoPlay - ${playerTitle} (Secured)`,
                                url: postRes.data.securedLink,
                                behaviorHints: {
                                    notWebReady: true, // Кара Stremio Web да го отвори във външен плеър, а Desktop си го пуска вътре
                                    proxyHeaders: {
                                        request: {
                                            "User-Agent": UA,
                                            "Referer": playerUrl,
                                            "Origin": `https://${domain}`
                                        }
                                    }
                                }
                            });
                        }
                    } catch (err) {
                        // fallback
                    }
                }
            }
        }

        return { streams };
    } catch (e) {
        return { streams: [] };
    }
});

const app = express();

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    next();
});

const addonInterface = builder.getInterface();

app.get('/manifest.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.send(addonInterface.manifest);
});

async function handleAddonReq(req, res) {
    const { resource, type, id, extra } = req.params;
    let extraParsed = {};
    
    if (extra) {
        extra.split('&').forEach(part => {
            const [key, value] = part.split('=');
            if (key && value) extraParsed[key] = decodeURIComponent(value);
        });
    }

    try {
        if (resource === 'stream') {
            const resp = await addonInterface.get('stream', type, id, extraParsed);
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
            return res.json(resp);
        }
        if (resource === 'catalog') {
            const resp = await addonInterface.get('catalog', type, id, extraParsed);
            return res.json(resp);
        }
        if (resource === 'meta') {
            const resp = await addonInterface.get('meta', type, id);
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
            return res.json(resp);
        }
        res.status(404).send('Not found');
    } catch (e) {
        res.status(500).send('Internal Server Error');
    }
}

app.get('/:resource/:type/:id/:extra.json', handleAddonReq);
app.get('/:resource/:type/:id.json', (req, res) => {
    req.params.extra = null;
    return handleAddonReq(req, res);
});

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
    <html>
        <head><title>ZenoPlay Addon</title></head>
        <body style="font-family: Arial; text-align: center; margin-top: 50px;">
            <h1>ZenoPlay Stremio Addon е активен! (v1.4.4)</h1>
            <p><a href="/manifest.json" style="font-size: 20px; color: #0066cc;">Инсталирай в Stremio (Кликни тук)</a></p>
        </body>
    </html>`);
});

if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 7000;
    app.listen(PORT, () => {
        console.log(`Addon running on http://127.0.0.1:${PORT}`);
    });
}

module.exports = app;
