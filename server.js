const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" }, pingTimeout: 60000 });
const net = require('net');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const isPkg = typeof process.pkg !== 'undefined';
const BASE_DIR = isPkg ? path.dirname(process.execPath) : __dirname;

const CryptoEngine = {
    xor: (buffer, key) => {
        let result = Buffer.alloc(buffer.length);
        for (let i = 0; i < buffer.length; i++) result[i] = buffer[i] ^ key[i % key.length];
        return result;
    },
    rc4: (buffer, key) => {
        const cipher = crypto.createCipheriv('rc4', key, '');
        return Buffer.concat([cipher.update(buffer), cipher.final()]);
    }
};

const PLUGINS_DIR = path.join(BASE_DIR, 'plugins');
if (!fs.existsSync(PLUGINS_DIR)) fs.mkdirSync(PLUGINS_DIR);

let loadedPlugins = [];
const dynRequire = eval('require');

function loadPlugins() {
    loadedPlugins = [];
    fs.readdirSync(PLUGINS_DIR).forEach(file => {
        if (file.endsWith('.js')) {
            const pluginPath = path.join(PLUGINS_DIR, file);
            delete dynRequire.cache[dynRequire.resolve(pluginPath)];
            loadedPlugins.push(dynRequire(pluginPath));
            console.log(`[PLUGIN] Yüklendi: ${file}`);
        }
    });
}
loadPlugins();

process.on('uncaughtException', (err) => {
    if (err.code !== 'EADDRINUSE') console.error(err);
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(__dirname));
const LOG_PORT = 4000;
const COMMAND_PORT = 4001;
const HOST = '127.0.0.1';
let gidCounter = 1;
const GID_RANGE = { MIN: 800000000, MAX: 899999999 };
const activePlayers = new Map();

function addPlayerDirect(gidDec, gidHex, nickname, forceEmit = false) {
    if (activePlayers.has(gidDec) && !forceEmit) return;
    activePlayers.set(gidDec, { nickname, gidHex, addedAt: new Date() });
    console.log(`[+] EKRANA BASILDI: ${nickname} (GID: ${gidDec})`);
    io.emit('gid_data', {
        id: gidCounter++,
        nickname: nickname,
        gidDec: gidDec,
        gidHex: gidHex,
        time: new Date().toLocaleTimeString()
    });
}

let gameItemDatabase = [];
let productMap = new Map();

function loadGameDatabase() {
    try {
        const clothPath = path.join(BASE_DIR, 'cloth.json');
        const goodsPath = path.join(BASE_DIR, 'goodslist.json');
        const productPath = path.join(BASE_DIR, 'productlist.json'); 
        const couplePath = path.join(BASE_DIR, 'coupleItem.json');
        const luckyPath = path.join(BASE_DIR, 'luckyboxItem.json');
        const homePath = path.join(BASE_DIR, 'home.json');

        if (fs.existsSync(productPath)) {
            const productData = JSON.parse(fs.readFileSync(productPath, 'utf8'));
            productData.forEach(p => {
                if(p.GoodsIDs) {
                    const gIds = p.GoodsIDs.split(',');
                    gIds.forEach(gid => {
                        if (gid && gid !== "0") {
                            productMap.set(gid.trim(), {
                                productID: p.ProductID,
                                sellEnd: p.SellEnd
                            });
                        }
                    });
                }
            });
        }

        if (fs.existsSync(clothPath) && fs.existsSync(goodsPath)) {
            const clothData = JSON.parse(fs.readFileSync(clothPath, 'utf8'));
            const goodsData = JSON.parse(fs.readFileSync(goodsPath, 'utf8'));

            const extraData = [];
            [couplePath, luckyPath, homePath].forEach(p => {
                if (fs.existsSync(p)) {
                    extraData.push(...JSON.parse(fs.readFileSync(p, 'utf8')));
                }
            });

            const goodsMap = {};
            goodsData.forEach(g => {
                let firstItemId = g.ItemIDs.split(',')[0];
                goodsMap[firstItemId] = g;
            });

            const allItems = [...clothData, ...extraData];

            allItems.forEach(item => {
                if (goodsMap[item.ID]) {
                    let goods = goodsMap[item.ID];
                    let bigIntVal = BigInt(goods.GoodsID);
                    let hexStr = bigIntVal.toString(16).toUpperCase().padStart(16, '0');
                    let littleEndianHex = hexStr.match(/.{1,2}/g).reverse().join('');

                    gameItemDatabase.push({
                        name: item.Name,
                        desc: item.Desc || "Açıklama yok",
                        sex: item.Sex === 2 ? "Kadın" : (item.Sex === 1 ? "Erkek" : "Unisex"),
                        duration: goods.ItemUseDurations.split(',')[0] === "20000" ? "Sınırsız" : "Süreli",
                        price: goods.Price,
                        goodsId: goods.GoodsID,
                        hex: littleEndianHex,
                        category: item.Category || 0
                    });
                }
            });
            console.log(`\n[💎 VERİTABANI] Toplam ${gameItemDatabase.length} eşya yüklendi!`);
        } else {
            console.log("\n[⚠️ UYARI] Temel cloth.json veya goodslist.json bulunamadı. (Klasöre kopyalayın)");
        }
    } catch (e) {
        console.error("\n[HATA] Veritabanı yüklenirken hata oluştu:", e.message);
    }
}

let ultimateData = [];
let ultimateFilters = { durations: [], mainCats: [], subCats: [] };

function toLittleEndianHexFromStr(input) {
    if (!input) return "";
    try {
        let bigIntVal = BigInt(input);
        let hexStr = bigIntVal.toString(16).toUpperCase();
        hexStr = hexStr.padStart(16, '0');
        return hexStr.match(/.{1,2}/g).reverse().join('');
    } catch (e) {
        return input;
    }
}

function loadUltimateDatabase() {
    try {
        const ultPath = path.join(BASE_DIR, 'Ultimate_Matched_Results.json');
        if (!fs.existsSync(ultPath)) {
            console.log("[⚠️ UYARI] Ultimate_Matched_Results.json bulunamadı. (Klasöre kopyalayın)");
            return;
        }

        const rawData = JSON.parse(fs.readFileSync(ultPath, 'utf8'));

        const priceMap = new Map();
        gameItemDatabase.forEach(g => {
            priceMap.set(g.goodsId.toString(), g.price);
        });

        const durations = new Set();
        const mainCats = new Set();
        const subCats = new Set();

        ultimateData = rawData.map(item => {
            const goodsId = item["Magaza ID (GoodsID)"]?.toString() || "";
            let priceNum = -1;
            let priceText = "Bilinmiyor";

            if (priceMap.has(goodsId)) {
                priceNum = priceMap.get(goodsId);
                priceText = priceNum === 0 ? "Bedava" : priceNum + " Nakit";
            }

            if (item["Sure / Tur"]) durations.add(item["Sure / Tur"]);
            if (item["Ana Kategori"]) mainCats.add(item["Ana Kategori"]);
            if (item["Alt Kategori"]) subCats.add(item["Alt Kategori"]);

            let productHex = "";
            let sellEndHex = "";

            if (productMap.has(goodsId)) {
                const pInfo = productMap.get(goodsId);
                if (pInfo.productID) productHex = toLittleEndianHexFromStr(pInfo.productID.toString());
                if (pInfo.sellEnd) sellEndHex = toLittleEndianHexFromStr(pInfo.sellEnd.toString());
            } else {
                if (item["ProductID"]) productHex = toLittleEndianHexFromStr(item["ProductID"].toString());
                if (item["SellEnd"]) sellEndHex = toLittleEndianHexFromStr(item["SellEnd"].toString());
            }

            return {
                "Kiyafet Adi (Name)": item["Kiyafet Adi (Name)"] || "",
                "Kiyafet ID Hex": productHex,
                "Little Endian HEX": item["Little Endian HEX"] || "",
                "Sure / Tur": item["Sure / Tur"] || "",
                "Magaza ID (GoodsID)": item["Magaza ID (GoodsID)"] || "",
                "Paket / Satis Adi": sellEndHex,
                "Ana Kategori": item["Ana Kategori"] || "",
                "Alt Kategori": item["Alt Kategori"] || "",
                "Fiyat Num": priceNum,
                "Fiyat Text": priceText
            };
        });

        ultimateFilters.durations = Array.from(durations).sort();
        ultimateFilters.mainCats = Array.from(mainCats).sort();
        ultimateFilters.subCats = Array.from(subCats).sort();

        console.log(`[📦 ULTIMATE DB] ${ultimateData.length} Satır Başarıyla Node.js RAM'ine Alındı!`);
    } catch (e) {
        console.error("[HATA] Ultimate Data Yüklenemedi:", e.message);
    }
}

loadGameDatabase();
loadUltimateDatabase();

app.get('/api/game-items', (req, res) => { res.json(gameItemDatabase); });
app.get('/api/ultimate-filters', (req, res) => { res.json(ultimateFilters); });

app.get('/api/ultimate-items', (req, res) => {
    const { search, duration, mainCat, subCat, sortBy, sortAsc } = req.query;
    let filtered = ultimateData;

    if (search) {
        const s = search.toLowerCase();
        filtered = filtered.filter(item =>
            (item["Kiyafet Adi (Name)"] && item["Kiyafet Adi (Name)"].toLowerCase().includes(s)) ||
            (item["Little Endian HEX"] && item["Little Endian HEX"].toLowerCase().includes(s)) ||
            (item["Kiyafet ID Hex"] && item["Kiyafet ID Hex"].toLowerCase().includes(s)) ||
            (item["Fiyat Text"] && item["Fiyat Text"].toLowerCase().includes(s)) ||
            (item["Paket / Satis Adi"] && item["Paket / Satis Adi"].toLowerCase().includes(s))
        );
    }

    if (duration) filtered = filtered.filter(i => i["Sure / Tur"] === duration);
    if (mainCat) filtered = filtered.filter(i => i["Ana Kategori"] === mainCat);
    if (subCat) filtered = filtered.filter(i => i["Alt Kategori"] === subCat);

    if (sortBy !== undefined && sortBy !== "undefined") {
        const key = sortBy;
        const isAsc = sortAsc === 'true';
        filtered = filtered.slice().sort((a, b) => {
            let valA = a[key] !== undefined && a[key] !== null ? a[key] : "";
            let valB = b[key] !== undefined && b[key] !== null ? b[key] : "";

            if (typeof valA === 'number' && typeof valB === 'number') {
                return isAsc ? valA - valB : valB - valA;
            }

            if (!isNaN(valA) && !isNaN(valB) && valA.toString().trim() !== "" && valB.toString().trim() !== "") {
                valA = Number(valA);
                valB = Number(valB);
            } else {
                valA = valA.toString().toLowerCase();
                valB = valB.toString().toLowerCase();
            }

            if (valA < valB) return isAsc ? -1 : 1;
            if (valA > valB) return isAsc ? 1 : -1;
            return 0;
        });
    }

    const total = filtered.length;
    const data = filtered.slice(0, 100);

    res.json({ total, data });
});

function processPacketWithBuffer(hexString) {
    if (!hexString) return;
    const isInfoPacket = hexString.includes("430055000120070400");
    const forceEmit = isInfoPacket;

    for (let plugin of loadedPlugins) {
        if (plugin.onPacket) {
            hexString = plugin.onPacket(hexString, isInfoPacket ? 'S2C' : 'C2S', CryptoEngine) || hexString;
        }
    }

    try {
        const cleanHex = hexString.replace(/[\s\n\r]/g, "").toUpperCase();
        const buffer = Buffer.from(cleanHex, 'hex');
        const targetSequence = Buffer.from("FFFE01", "hex");
        let searchIndex = 0;
        while (searchIndex < buffer.length) {
            const matchIndex = buffer.indexOf(targetSequence, searchIndex);
            if (matchIndex === -1) break;
            searchIndex = matchIndex + targetSequence.length;
            if (matchIndex + 35 + 2 > buffer.length) continue;
            const gidOffset = matchIndex + 0x1B;
            const gid = buffer.readUInt32LE(gidOffset);
            if (gid < GID_RANGE.MIN || gid > GID_RANGE.MAX) continue;
            const gidHexLE = buffer.subarray(gidOffset, gidOffset + 4).toString('hex').toUpperCase();
            let nickname = "";
            const nextPacketIndex = buffer.indexOf(targetSequence, searchIndex);
            const searchLimit = nextPacketIndex !== -1 ? nextPacketIndex : buffer.length;
            for (let i = gidOffset + 4; i < buffer.length - 2; i++) {
                if (i >= searchLimit) break;
                const possibleLength = buffer.readUInt8(i);
                if (possibleLength >= 2 && possibleLength <= 16) {
                    let isValid = true;
                    let tempName = "";
                    let strStart = i + 1;
                    if (strStart + (possibleLength * 2) <= searchLimit) {
                        for (let j = 0; j < possibleLength; j++) {
                            const charCode = buffer.readUInt16LE(strStart + (j * 2));
                            if ((charCode >= 0x20 && charCode <= 0x7E) || (charCode >= 0xC0 && charCode <= 0x2AF)) {
                                tempName += String.fromCharCode(charCode);
                            } else {
                                isValid = false; break;
                            }
                        }
                        if (isValid && tempName.length === possibleLength) {
                            nickname = tempName; break;
                        }
                    }
                }
            }
            if (!nickname) {
                let longestStr = "";
                for (let i = gidOffset + 4; i < searchLimit - 1; i++) {
                    let tempStr = "";
                    for (let k = i; k < searchLimit - 1; k += 2) {
                        const charCode = buffer.readUInt16LE(k);
                        if ((charCode >= 0x20 && charCode <= 0x7E) || (charCode >= 0xC0 && charCode <= 0x2AF)) {
                            tempStr += String.fromCharCode(charCode);
                        } else { break; }
                    }
                    if (tempStr.length > longestStr.length) longestStr = tempStr;
                }
                if (longestStr.length >= 2) nickname = longestStr;
            }
            if (nickname) {
                if (forceEmit) console.log(`\n[⚡ SAĞ TIK BİLGİSİ] Nick: ${nickname}, GID: ${gid}, Hex: ${gidHexLE}`);
                addPlayerDirect(gid.toString(), gidHexLE, nickname, forceEmit);
            }
        }
    } catch (error) { console.error("[HATA] Buffer Parser: ", error.message); }
}

const tcpServer = net.createServer((socket) => {
    socket.on('data', (data) => {
        try {
            const strData = data.toString();
            const packets = strData.replace(/}{/g, '}|{').split('|');
            packets.forEach(pkt => {
                if (!pkt.trim()) return;
                try {
                    let parsedPkt = JSON.parse(pkt);
                    io.emit('packet_data', parsedPkt);
                    if (parsedPkt.dir === "S2C") { processPacketWithBuffer(parsedPkt.hex); }
                } catch (e) { }
            });
        } catch (e) { }
    });
    socket.on('error', () => { });
});
// TCP Bağlantı sorununu çözen kilit satır:
tcpServer.listen(LOG_PORT, '127.0.0.1', () => { });

function sendToProxy(data) {
    const client = new net.Socket();
    client.connect(COMMAND_PORT, HOST, () => {
        client.write(JSON.stringify(data));
        client.end();
    });
    client.on('error', (err) => { });
}

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });
app.post('/inject-packet', (req, res) => { sendToProxy({ type: "INJECT", ...req.body }); res.sendStatus(200); });
app.post('/set-rule', (req, res) => { sendToProxy({ type: "SET_RULE", ...req.body }); res.sendStatus(200); });
app.post('/update-triggers', (req, res) => { sendToProxy({ type: "TRIGGERS", data: req.body.data }); res.sendStatus(200); });

function getIPAddresses() {
    const interfaces = os.networkInterfaces();
    const addresses = [];
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                addresses.push({ name, address: iface.address });
            }
        }
    }
    return addresses;
}

const PORT = 3000;
// Çift tarayıcı açılma sorununu çözen kısım (exec kaldırıldı)
const server = http.listen(PORT, '0.0.0.0', () => {
    console.log(`\n==================================================`);
    console.log(`🚀 DRAGON ENGINE AKTİF! UI Port: ${PORT}`);
    console.log(`--------------------------------------------------`);
    const ips = getIPAddresses();
    if (ips.length > 0) {
        ips.forEach(ip => {
            console.log(`🏠 Erişim: http://${ip.address}:${PORT}`);
        });
    }
    console.log(`==================================================\n`);
});
