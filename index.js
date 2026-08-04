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
    catalogs: [], // Използваме вградения каталог на Stremio за максимална стабилност
    resources: ['stream'],
    idPrefixes: ['tt'] // Важно: Свързва се с официалните IMDb ID-та на Stremio
};

const builder = new addonBuilder(manifest);
const app = express();

// Помощна функция за почистване и подготовка на заглавието за търсене в ZenoPlay
function slugify(text) {
    return text.toString().toLowerCase().trim()
        .replace(/\s+/g, '-')           // Заменя интервалите с тирета
        .replace(/[^\w\-]+/g, '')       // Премахва специални символи
        .replace(/\-\-+/g, '-');        // Премахва двойни тирета
}

// Стрийминг хендлър
builder.defineStreamHandler(async ({ type, id }) => {
    try {
        console.log(`[ZenoPlay] Търсене на стрийм за ID: ${id}`);
        
        // 1. Взимане на метаданни (име на филма) от Stremio API чрез IMDb ID-то
        const metaResponse = await axios.get(`https://stremio.io{type}/${id}.json`);
        if (!metaResponse.data || !metaResponse.data.meta) {
            return { streams: [] };
        }
        
        const movieName = metaResponse.data.meta.name;
        const cleanSlug = slugify(movieName);
        
        // Формиране на директния линк към филма в ZenoPlay
        // Пример: https://zenoplay.to
        const targetUrl = `${BASE_URL}/${type === 'movie' ? 'movie' : 'tv-show'}/${cleanSlug}/`;
        
        console.log(`[ZenoPlay] Опит за достъп до: ${targetUrl}`);
        
        const response = await axios.get(targetUrl, { headers: { 'User-Agent': UA } });
        const $ = cheerio.load(response.data);
        const streams = [];

        // 2. Извличане на наличните плеъри от страницата
        $('iframe, button[data-url], a[data-url], div[data-url], .player-item').each((i, el) => {
            let dataUrl = $(el).attr('src') || $(el).attr('data-url') || $(el).attr('data-link') || $(el).attr('data-src') || $(el).attr('href');
            let btnText = $(el).text().trim() || $(el).attr('title') || `Плеър ${i + 1}`;
            
            if (dataUrl) {
                let normalizedUrl = dataUrl.startsWith('//') ? 'https:' + dataUrl : dataUrl;
                
                if (!normalizedUrl.includes('morencius.com') && !normalizedUrl.includes('facebook.com')) {
                    streams.push({
                        title: `🎬 Пусни в Браузър [${btnText}]`,
                        description: `Ще се отвори външно в браузъра със субтитри от ZenoPlay`,
                        externalUrl: normalizedUrl // Отваря линка извън Stremio, заобикаляйки ограниченията на плеъра
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

// Свързване на SDK-то с Express
const addonRouter = getRouter(builder);
app.use('/', addonRouter);

const port = process.env.PORT || 7000;
app.listen(port, () => {
    console.log(`Добавката е готова! За инсталация в Stremio отворете линка:`);
    console.log(`http://localhost:${port}/manifest.json`);
});
