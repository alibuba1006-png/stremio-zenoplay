const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const express = require("express");
const axios = require("axios");

const app = express();

// 1. Дефиниране на Stremio манифеста с дефиниран каталог за филми
const builder = new addonBuilder({
    id: "org.zenoplay.stremio",
    version: "1.0.0",
    name: "ZenoPlay Addon",
    description: "Stremio addon for zenoplay.to with built-in HLS proxy",
    types: ["movie", "series"],
    catalogs: [
        {
            type: "movie",
            id: "zenoplay_movies",
            name: "ZenoPlay Филми"
        }
    ],
    resources: ["catalog", "stream"]
});

// 2. Обработчик на каталога (връща списък с филми/съдържание)
builder.defineCatalogHandler(async function(args) {
    try {
        const { type, id } = args;
        console.log(`Заявка за каталог - Тип: ${type}, ID: ${id}`);
        
        // Тук може да се добави лоциране и парсване на филми от zenoplay.to
        const metas = [];

        return { metas };
    } catch (error) {
        console.error("Грешка при извличане на каталога:", error.message);
        return { metas: [] };
    }
});

// 3. Обработчик на стриймовете
builder.defineStreamHandler(async function(args) {
    try {
        const { type, id } = args;
        console.log(`Заявка за стрийъм - Тип: ${type}, ID: ${id}`);
        
        const streams = [];

        return { streams };
    } catch (error) {
        console.error("Грешка при извличане на стрийъм:", error.message);
        return { streams: [] };
    }
});

// 4. Свързване на Stremio интерфейса към Express приложението
app.use(getRouter(builder.getInterface()));

// 5. Допълнителен прокси маршрут за HLS стриймове
app.get("/proxy", async (req, res) => {
    try {
        const targetUrl = req.query.url;
        if (!targetUrl) {
            return res.status(400).send("Липсва URL адрес за проксиране.");
        }

        const response = await axios({
            method: "get",
            url: targetUrl,
            responseType: "stream",
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                "Referer": "https://zenoplay.to/"
            }
        });

        response.data.pipe(res);
    } catch (error) {
        console.error("Грешка в проксито:", error.message);
        res.status(500).send("Грешка при проксиране на медията.");
    }
});

// 6. Стартиране на уеб сървъра на задължителния за Render порт и адрес
const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`====================================================`);
    console.log(` ZenoPlay Addon & Proxy активни на порт: ${PORT}`);
    console.log(`====================================================`);
});
