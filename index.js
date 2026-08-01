const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");

const app = express();

// 1. Дефиниране на Stremio манифеста
const builder = new addonBuilder({
    id: "org.zenoplay.stremio",
    version: "1.0.0",
    name: "ZenoPlay Addon",
    description: "Stremio addon for zenoplay.to with built-in HLS proxy",
    types: ["movie", "series"],
    catalogs: [],
    resources: ["stream"]
});

// 2. Дефиниране на стрийм хандлъра
builder.defineStreamHandler(async function(args) {
    try {
        const { type, id } = args;
        console.log(`Заявка за стрийъм - Тип: ${type}, ID: ${id}`);

        // Тук се поставя логиката за извличане от zenoplay.to
        const streams = [];

        // Пример за добавяне на стрийъм, който минава през нашия прокси рутер
        // const proxyUrl = `https://${process.env.RENDER_EXTERNAL_URL || 'localhost:10000'}/proxy?url=${encodeURIComponent(targetVideoUrl)}`
        // streams.push({
        //     title: "ZenoPlay Stream",
        //     url: proxyUrl
        // });

        return { streams };
    } catch (error) {
        console.error("Грешка при извличане на стрийъм:", error.message);
        return { streams: [] };
    }
});

// 3. Интегриране на Stremio рутера в Express приложението
app.use(getRouter());

// 4. Допълнителен рутер за проксиране на HLS сегменти/глави (по избор)
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

// 5. Стартиране на сървъра на задължителния порт за Render (0.0.0.0)
const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`====================================================`);
    console.log(` ZenoPlay Addon & Proxy активни на порт: ${PORT}`);
    console.log(`====================================================`);
});
