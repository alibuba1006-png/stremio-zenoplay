const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const express = require('express');

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0";
const BASE_URL = "https://zenoplay.to";

const manifest = {
    id: 'org.zenoplay.proxy',
    version: '1.4.1',
    name: 'ZenoPlay Direct Proxy',
    description: 'Stremio addon with strictly single source and subtitles support',
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
    resources: ['catalog', 'meta', 'stream', 'subtitles'],
    idPrefixes: ['zeno_']
};

const builder = new addonBuilder(manifest);
const app = express();

app.use(express.json());
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
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

        return { meta };
    } catch (e) {
        console.error(`[META ERROR]:`, e);
        return { meta: { id, type, name: "Грешка при зареждане" } };
    }
});

// 3. Стрийминг хендлър
builder.defineStreamHandler(async ({ type, id }) => {
    try {
        let pageLink = '';
        
        if (id.includes(':')) {
            const parts = id.split(':');
            const encodedEpPath = parts[1];
            pageLink = Buffer.from(encodedEpPath, 'base64').toString('utf8');
        } else {
            const encodedPath = id.replace('zeno_', '');
            pageLink = Buffer.from(encodedPath, 'base64').toString('utf8');
        }

        const url = pageLink.startsWith('http') ? pageLink : BASE_URL + pageLink;
        const response = await axios.get(url, { headers: { 'User-Agent': UA } });
        const html = response.data;
        const $ = cheerio.load(html);

        const streams = [];

        $('button[data-url], a[data-url], div[data-url], iframe, .player-item').each((i, el) => {
            let dataUrl = $(el).attr('data-url') || $(el).attr('data-link') || $(el).attr('data-src') || $(el).attr('src') || $(el).attr('href');
            const btnText = $(el).text().trim() || $(el).attr('title') || `Плеър ${i + 1}`;
            
            if (dataUrl) {
                const normalizedUrl = dataUrl.startsWith('//') ? 'https:' + dataUrl : dataUrl;
                if (!normalizedUrl.includes('morencius.com') && normalizedUrl.startsWith('http')) {
                    streams.push({
                        title: `ZenoPlay - ${btnText}`,
                        url: normalizedUrl
                    });
                }
            }
        });

        if (streams.length === 0) {
            $('iframe').each((i, el) => {
                const src = $(el).attr('src');
                if (src && src.startsWith('http')) {
                    streams.push({
                        title: `Плеър ${i + 1}`,
                        url: src
                    });
                }
            });
        }

        return { streams };
    } catch (e) {
        console.error(`[STREAM ERROR]:`, e);
        return { streams: [] };
    }
});

// 4. Субтитри
builder.defineSubtitlesHandler(async ({ type, id }) => {
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
        const html = response.data;
        const $ = cheerio.load(html);
        
        const subtitles = [];

        $('track[kind="subtitles"], track[kind="captions"]').each((_, el) => {
            let src = $(el).attr('src');
            let lang = $(el).attr('srclang') || 'bg';
            let label = $(el).attr('label') || 'Български';
            
            if (src) {
                if (src.startsWith('//')) src = 'https:' + src;
                else if (src.startsWith('/')) src = BASE_URL + src;

                subtitles.push({
