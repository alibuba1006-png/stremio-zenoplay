const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const express = require('express');

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const BASE_URL = "https://zenoplay.to";

const manifest = {
    id: 'org.zenoplay.direct',
    version: '1.5.0',
    name: 'ZenoPlay БГ Стрийм',
    description: 'Гледайте филми директно от ZenoPlay във външен браузър',
    types: ['movie', 'series'],
    catalogs: [], 
    resources: ['stream'],
    idPrefixes: ['tt'] 
};

const builder = new addonBuilder(manifest);
const app = express();

function slugify(text) {
    return text.toString().toLowerCase().trim()
        .replace(/\s+/g, '-')           
        .replace(/[^\w\-]+/g, '')       
        .replace(/\-\-+/g, '-');        
}

builder.defineStreamHandler(async ({ type, id }) => {
    try {
        console.log(`[ZenoPlay] Търсене на стрийм за ID: ${id}`);
        
        const metaResponse = await axios.get(`https://stremio.io{type}/${id}.json`);
        if (!metaResponse.data || !metaResponse.data.meta) {
            return { streams: [] };
        }
        
        const movieName = metaResponse.data.meta.name;
        const cleanSlug = slugify(movieName);
        const targetUrl = `${BASE_URL}/${type === 'movie' ? 'movie' : 'tv-show'}/${cleanSlug}/`;
        
        console.log(`[ZenoPlay] Опит за достъп до: ${targetUrl}`);
        
        const response = await axios.get(targetUrl, { headers: { 'User-Agent': UA } });
        const $ = cheerio.load(response.data);
        const streams = [];

        $('iframe, button[data-url], a[data-url], div[data-url], .player-item').each((i, el) => {
            let dataUrl = $(el).attr('src') || $(el).attr('data-url') || $(el).attr('data-link') || $(el).attr('data-src') || $(el).attr('href');
            let btnText = $(el).text().trim() || $(el).attr('title') || `Плеър ${i + 1}`;
            
            if (dataUrl) {
                let normalizedUrl = dataUrl.startsWith('//') ? 'https:' + dataUrl : dataUrl;
                
                if (!normalizedUrl.includes('morencius.com') && !normalizedUrl.includes('facebook.com')) {
                    streams.push({
                        title: `🎬 Пусни в Браузър [${btnText}]`,
                        description: `Ще се отвори външно в браузъра със субтитри от ZenoPlay`,
                        externalUrl: normalizedUrl 
                    });
                }
            }
        });

        return { streams };
    } catch (e) {
        console.error(`[ZenoPlay ГРЕШКА]:`, e.message);
        return { streams: [] };
    }
});

// КРИТИЧНА ПОПРАВКА: Подава се builder.getInterface() вместо само builder
const addonRouter = getRouter(builder.getInterface());
app.use('/', addonRouter);

const port = process.env.PORT || 7000;
app.listen(port, () => {
    console.log(`Добавката е готова на порт ${port}`);
});
