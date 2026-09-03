const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
} = require("@itsliaaa/baileys"); // fork resmi Baileys, sudah fix bug upload media ke channel/newsletter
const { Boom } = require("@hapi/boom");
const pino = require("pino");
const fs = require("fs");
const path = require("path");
const http = require("http");
const qrcodeTerminal = require("qrcode-terminal");
const QRCode = require("qrcode");
const readline = require("readline");
let Jimp = null;
try {
  Jimp = require("jimp"); // dipakai buat .qc (bikin stiker teks). Kalau belum diinstall, .qc bakal kasih tau caranya.
} catch {
  // sengaja diem, dicek pas .qc dipanggil
}
const DEFAULT_CONFIG = { ownerNumber: "", prefix: ".", defaultIntervalMinutes: 1, loginMethod: "" };
let config = DEFAULT_CONFIG;
try {
  config = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync("./config.json", "utf-8")) };
} catch {
  console.log("ℹ️ config.json tidak ditemukan, pakai default (prefix '.', interval 1 menit). Nomor tetap wajib lewat env OWNER_NUMBER.");
}
// Nomor bisa diisi lewat ENV (dianjurkan di Railway) atau langsung di config.json.
// Kalau nggak diisi sama sekali dan pilih login pairing, bot bakal nanya nomornya di terminal.
let OWNER_NUMBER = (process.env.OWNER_NUMBER || config.ownerNumber || "").replace(/[^0-9]/g, "");
function askOwnerNumber() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = () => {
      rl.question(
        "\n📱 Masukin nomor WA yang mau dipakai bot (pakai kode negara, tanpa + atau spasi, contoh: 628123456789): ",
        (answer) => {
          const num = answer.replace(/[^0-9]/g, "");
          if (num.length < 8) {
            console.log("⚠️ Nomor kelihatannya belum bener, coba lagi.");
            ask();
          } else {
            rl.close();
            resolve(num);
          }
        }
      );
    };
    ask();
  });
}
// Metode login bisa dipaksa lewat ENV LOGIN_METHOD / config.json ("qr" atau "pairing").
// Kalau nggak diset sama sekali dan belum login, bot bakal nanya interaktif di terminal.
let chosenLoginMethod = null;
function askLoginMethod() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = () => {
      rl.question(
        "\n=== PILIH METODE LOGIN ===\n1. Scan QR Code\n2. Pairing Code (masukin kode manual)\nKetik 1 atau 2 lalu Enter: ",
        (answer) => {
          const a = answer.trim();
          if (a === "1") {
            rl.close();
            resolve("qr");
          } else if (a === "2") {
            rl.close();
            resolve("pairing");
          } else {
            console.log("⚠️ Input tidak valid, ketik 1 atau 2 aja.");
            ask();
          }
        }
      );
    };
    ask();
  });
}
async function resolveLoginMethod() {
  if (chosenLoginMethod) return chosenLoginMethod;
  const forced = (process.env.LOGIN_METHOD || config.loginMethod || "").toLowerCase();
  if (forced === "qr" || forced === "pairing") {
    chosenLoginMethod = forced;
    return chosenLoginMethod;
  }
  if (process.stdin.isTTY) {
    chosenLoginMethod = await askLoginMethod();
  } else {
    chosenLoginMethod = "qr"; // fallback kalau jalan non-interaktif (misal di Railway tanpa TTY)
  }
  return chosenLoginMethod;
}
const GROUPS_FILE = "./groups.json";
const TARGET_FILE = "./target.json";
const BC_STATE_FILE = "./bcstate.json";
const TEMPLATES_FILE = "./templates.json";
const STATS_FILE = "./stats.json";
const SCHEDULE_FILE = "./schedule.json";
const TESTI_FILE = "./testimoni.json";
const TESTI_CHANNEL_FILE = "./testichannel.json";

// ---------- state & server buat nampilin QR lewat browser (berguna banget kalau jalan di Railway) ----------
let latestQR = null;
let qrServerStarted = false;

function startQRServer() {
  if (qrServerStarted) return;
  qrServerStarted = true;
  const port = process.env.PORT || 3000;
  const server = http.createServer(async (req, res) => {
    if (req.url === "/qr.png") {
      if (!latestQR) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        return res.end("Belum ada QR aktif (mungkin sudah login atau belum siap).");
      }
      try {
        const buffer = await QRCode.toBuffer(latestQR, { width: 320, margin: 2 });
        res.writeHead(200, { "Content-Type": "image/png" });
        return res.end(buffer);
      } catch (e) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        return res.end("Gagal generate QR: " + e.message);
      }
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta http-equiv="refresh" content="5">
<title>QR Login WA Bot</title>
<style>body{font-family:sans-serif;text-align:center;padding-top:40px;background:#111;color:#eee}
img{background:#fff;padding:16px;border-radius:8px}</style></head>
<body>
<h2>Scan QR buat login WA</h2>
${latestQR
  ? `<img src="/qr.png" alt="QR Code" />`
  : `<p>Menunggu QR baru dari WhatsApp... (halaman auto-refresh tiap 5 detik)</p>`}
<p style="opacity:.6">Halaman ini auto-refresh sendiri. Buka WhatsApp &gt; Perangkat Tertaut &gt; Tautkan perangkat, lalu scan.</p>
</body></html>`);
  });
  server.listen(port, () => {
    console.log(`🌐 Halaman QR bisa dibuka di http://localhost:${port} (kalau di Railway, buka lewat domain public dari Settings > Networking > Generate Domain)`);
  });
}

// ---------- helper penyimpanan sederhana pakai file JSON ----------
function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return fallback;
  }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let groups = readJSON(GROUPS_FILE, {}); // { id: subject }
let target = readJSON(TARGET_FILE, { mode: "all", ids: [] }); // mode: "all" | "custom"
let bcState = readJSON(BC_STATE_FILE, null); // { intervalMinutes, content } saat aktif
let templates = readJSON(TEMPLATES_FILE, {}); // { nama: savedContent }
let stats = readJSON(STATS_FILE, { totalBroadcasts: 0, totalSent: 0, totalFailed: 0, lastBroadcast: null });
let schedules = readJSON(SCHEDULE_FILE, []); // [{ id, time: "HH:MM", content, templateName }]
let testimonials = readJSON(TESTI_FILE, []); // [{ id, barang, tanggal, nominal, imageBase64, time }]
let testiChannel = readJSON(TESTI_CHANNEL_FILE, { jid: "" }); // channel WA tujuan auto-post testi

let intervalHandle = null;
let scheduleCheckerStarted = false;
let scheduleFiredKeys = {}; // cegah broadcast ganda di menit yg sama

function getTargetGroupIds() {
  if (target.mode === "all") return Object.keys(groups);
  return target.ids.filter((id) => groups[id]);
}

// ---------- helper konversi konten (in-memory <-> tersimpan di file) ----------
function toSavedContent(content) {
  if (content.type === "image") {
    return { type: "image", bufferBase64: content.buffer.toString("base64"), caption: content.caption || "" };
  }
  return content;
}
function toRuntimeContent(saved) {
  if (saved.type === "image") {
    return { type: "image", buffer: Buffer.from(saved.bufferBase64, "base64"), caption: saved.caption || "" };
  }
  return saved;
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("./session");

  let LOGIN_METHOD = "qr";
  if (!state.creds.registered) {
    LOGIN_METHOD = await resolveLoginMethod();
    if (LOGIN_METHOD === "pairing" && !OWNER_NUMBER) {
      OWNER_NUMBER = await askOwnerNumber();
    }
  }

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
  });

  // ---------- Login: pairing code ATAU QR code, tergantung LOGIN_METHOD ----------
  if (!sock.authState.creds.registered && LOGIN_METHOD === "pairing") {
    if (!OWNER_NUMBER) {
      console.error(
        "\n❌ Nomor WA belum diset. Isi environment variable OWNER_NUMBER (contoh: 628123456789) " +
          "di Railway (Settings > Variables), atau isi 'ownerNumber' di config.json kalau jalan lokal.\n"
      );
      return;
    }
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(OWNER_NUMBER);
        console.log("\n=== PAIRING CODE ===");
        console.log(code?.match(/.{1,4}/g)?.join("-") || code);
        console.log("Buka WhatsApp > Perangkat Tertaut > Tautkan dengan nomor telepon, masukkan kode di atas.");
        console.log("(Cek di sini / Logs Railway kalau jalan di Railway)\n");
      } catch (e) {
        console.error("Gagal minta pairing code:", e);
      }
    }, 2000);
  }

  // Server QR cuma perlu jalan sekali (kalau dipakai), biar ga tabrakan port pas reconnect
  if (LOGIN_METHOD === "qr" && !sock.authState.creds.registered) {
    startQRServer();
  }

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && LOGIN_METHOD === "qr") {
      latestQR = qr;
      console.log("\n=== SCAN QR CODE INI (WhatsApp > Perangkat Tertaut > Tautkan perangkat) ===");
      qrcodeTerminal.generate(qr, { small: true });
      console.log("Kalau QR di atas ga kebaca/ke-scan (sering kejadian di log Railway), buka halaman web-nya aja — lebih jelas.\n");
    }

    if (connection === "close") {
      const shouldReconnect =
        new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log("Koneksi terputus, reconnect:", shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === "open") {
      latestQR = null;
      console.log("✅ Bot tersambung ke WhatsApp!");
      // Kalau ada broadcast interval yang tadinya aktif sebelum bot restart, nyalain lagi
      if (bcState) {
        startBroadcastInterval(sock, bcState.intervalMinutes, bcState.content, false);
      }
      // Jalanin pengecek jadwal broadcast (cuma sekali walau reconnect berkali-kali)
      if (!scheduleCheckerStarted) {
        scheduleCheckerStarted = true;
        startScheduleChecker(sock);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg?.message) return;
    if (msg.key.fromMe !== true) return; // self-bot: hanya proses perintah dari akun bot sendiri (nomor lo)

    const jid = msg.key.remoteJid;
    const body =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      "";
    const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;

    if (body.startsWith(config.prefix)) {
      const [rawCmd, ...args] = body.slice(config.prefix.length).trim().split(/\s+/);
      try {
        await runCommand(sock, jid, msg, quoted, rawCmd.toLowerCase(), args);
      } catch (err) {
        console.error(err);
        await sock.sendMessage(jid, { text: "❌ Error: " + err.message });
      }
      return;
    }

  });

  return sock;
}

// ---------- daftar menu bernomor, dipakai buat teks .menu ----------
const MENU_ITEMS = [
  { num: 1, cmd: "listgrup", emoji: "👥", title: "List & simpan semua grup", hint: ".listgrup" },
  { num: 2, cmd: "cargrup", emoji: "🔎", title: "Cari grup by nama", hint: ".cargrup <keyword>" },
  { num: 3, cmd: "setgrup", emoji: "🎯", title: "Atur target grup", hint: ".setgrup all / id1,id2 / cari <keyword>" },
  { num: 4, cmd: "bc", emoji: "📤", title: "Kirim broadcast sekali", hint: "reply pesan/foto lalu .bc, atau .bc <template>" },
  { num: 5, cmd: "setbc", emoji: "⏰", title: "Auto-bc berkala", hint: "reply pesan lalu .setbc <menit>" },
  { num: 6, cmd: "stopbc", emoji: "🛑", title: "Matikan auto-bc", hint: ".stopbc" },
  { num: 7, cmd: "jadwalbc", emoji: "🗓️", title: "Jadwal broadcast harian", hint: ".jadwalbc <HH:MM>" },
  { num: 8, cmd: "listjadwal", emoji: "🗓️", title: "Lihat semua jadwal", hint: ".listjadwal" },
  { num: 9, cmd: "deljadwal", emoji: "🗓️", title: "Hapus jadwal", hint: ".deljadwal <ID>" },
  { num: 10, cmd: "savetpl", emoji: "📝", title: "Simpan template", hint: "reply pesan lalu .savetpl <nama>" },
  { num: 11, cmd: "listtpl", emoji: "📝", title: "Lihat semua template", hint: ".listtpl" },
  { num: 12, cmd: "deltpl", emoji: "📝", title: "Hapus template", hint: ".deltpl <nama>" },
  { num: 13, cmd: "stats", emoji: "📊", title: "Statistik broadcast", hint: ".stats" },
  { num: 14, cmd: "qc", emoji: "🖼️", title: "Bikin stiker teks putih-hitam", hint: "reply pesan teks lalu .qc" },
  { num: 15, cmd: "testi", emoji: "🧾", title: "Bikin testimoni dari foto transfer", hint: "reply foto lalu .testi <barang>, <tanggal>, <nominal>" },
  { num: 16, cmd: "listtesti", emoji: "🧾", title: "Lihat semua testimoni tersimpan", hint: ".listtesti" },
  { num: 17, cmd: "deltesti", emoji: "🧾", title: "Hapus testimoni", hint: ".deltesti <ID>" },
  { num: 18, cmd: "setchannel", emoji: "📣", title: "Atur channel WA tujuan auto-post testi", hint: ".setchannel <link/JID channel>" },
  { num: 19, cmd: "menu", emoji: "📖", title: "Tampilkan menu ini", hint: ".menu" },
];

// ---------- eksekutor command, dipanggil baik dari .prefix maupun shortcut angka ----------
async function runCommand(sock, jid, msg, quoted, cmd, args) {
  if (cmd === "listgrup" || cmd === "listgroup") {
    await handleListGroup(sock, jid);
  } else if (cmd === "bc" || cmd === "broadcast") {
    await handleBroadcastOnce(sock, jid, msg, quoted, args);
  } else if (cmd === "setbc") {
    await handleSetBc(sock, jid, msg, quoted, args);
  } else if (cmd === "stopbc") {
    await handleStopBc(sock, jid);
  } else if (cmd === "setgrup" || cmd === "settarget") {
    await handleSetTarget(sock, jid, args);
  } else if (cmd === "cargrup" || cmd === "cari") {
    await handleSearchGroup(sock, jid, args);
  } else if (cmd === "savetpl" || cmd === "addtpl") {
    await handleSaveTemplate(sock, jid, msg, quoted, args);
  } else if (cmd === "listtpl") {
    await handleListTemplate(sock, jid);
  } else if (cmd === "deltpl") {
    await handleDeleteTemplate(sock, jid, args);
  } else if (cmd === "jadwalbc") {
    await handleSetSchedule(sock, jid, msg, quoted, args);
  } else if (cmd === "listjadwal") {
    await handleListSchedule(sock, jid);
  } else if (cmd === "deljadwal") {
    await handleDeleteSchedule(sock, jid, args);
  } else if (cmd === "stats" || cmd === "statistik") {
    await handleStats(sock, jid);
  } else if (cmd === "qc" || cmd === "stiker" || cmd === "sticker") {
    await handleQuickChatSticker(sock, jid, msg, quoted, args);
  } else if (cmd === "testi" || cmd === "addtesti") {
    await handleAddTesti(sock, jid, msg, quoted, args);
  } else if (cmd === "listtesti") {
    await handleListTesti(sock, jid);
  } else if (cmd === "deltesti") {
    await handleDeleteTesti(sock, jid, args);
  } else if (cmd === "setchannel") {
    await handleSetTestiChannel(sock, jid, args);
  } else if (cmd === "menu" || cmd === "help") {
    await sendMenu(sock, jid);
  }
}

// ---------- fitur: animasi loading (progress bar hijau kayak ngisi baterai) ----------
function buildProgressBar(percent) {
  const totalBlocks = 10;
  const filled = Math.round((percent / 100) * totalBlocks);
  const bar = "🟩".repeat(filled) + "⬜".repeat(totalBlocks - filled);
  return `${bar}  ${percent}%`;
}

async function showLoadingAnimation(sock, jid, label = "Memproses") {
  const steps = [10, 30, 60, 90, 100];
  let msgKey = null;
  for (let i = 0; i < steps.length; i++) {
    const percent = steps[i];
    const text = `⏳ ${label}...\n${buildProgressBar(percent)}`;
    if (i === 0) {
      const sent = await sock.sendMessage(jid, { text });
      msgKey = sent.key;
    } else {
      await sock.sendMessage(jid, { text, edit: msgKey });
    }
    await delay(400);
  }
  return msgKey;
}

// ---------- fitur: list semua grup yg bot join ----------
async function handleListGroup(sock, jid) {
  const loadingKey = await showLoadingAnimation(sock, jid, "Mengambil daftar grup");
  const all = await sock.groupFetchAllParticipating();
  groups = {};
  let text = "👥 *Daftar Grup*\n\n";
  Object.values(all).forEach((g) => {
    groups[g.id] = g.subject;
    text += `• ${g.subject}\n  ${g.id}\n\n`;
  });
  writeJSON(GROUPS_FILE, groups);
  text += `📊 Total: *${Object.keys(groups).length} grup*\n💡 Default target: semua grup. Pakai .setgrup buat pilih sebagian, atau .cargrup <keyword> buat cari grup by nama.`;
  await sock.sendMessage(jid, { text, edit: loadingKey });
}


// ---------- fitur: cari grup by nama/keyword ----------
async function handleSearchGroup(sock, jid, args) {
  const loadingKey = await showLoadingAnimation(sock, jid, "Mencari grup");
  const keyword = args.join(" ").trim().toLowerCase();
  if (!keyword) {
    await sock.sendMessage(jid, { text: "🔎 Format: .cargrup <keyword>\nContoh: .cargrup alumni", edit: loadingKey });
    return;
  }
  const matches = Object.entries(groups).filter(([id, name]) => name.toLowerCase().includes(keyword));
  if (matches.length === 0) {
    await sock.sendMessage(jid, { text: `🔎 Tidak ada grup yang mengandung "${keyword}". Coba .listgrup dulu buat update daftar grup.`, edit: loadingKey });
    return;
  }
  let text = `🔎 *Hasil pencarian "${keyword}"* (${matches.length} grup)\n\n`;
  matches.forEach(([id, name]) => {
    text += `• ${name}\n  ${id}\n\n`;
  });
  text += `💡 Mau jadiin target semua hasil ini? Ketik: .setgrup cari ${keyword}`;
  await sock.sendMessage(jid, { text, edit: loadingKey });
}

// ---------- ambil konten (teks/foto) dari pesan yang di-reply ----------
async function extractContent(sock, quoted, msg) {
  if (!quoted) return null;

  const quotedMsgKey = {
    remoteJid: msg.key.remoteJid,
    id: msg.message.extendedTextMessage.contextInfo.stanzaId,
    participant: msg.message.extendedTextMessage.contextInfo.participant,
    fromMe: false,
  };

  const imageMsg = quoted.imageMessage;
  if (imageMsg) {
    const buffer = await downloadMediaMessage(
      { key: quotedMsgKey, message: quoted },
      "buffer",
      {}
    );
    return { type: "image", buffer, caption: imageMsg.caption || "" };
  }

  const text = quoted.conversation || quoted.extendedTextMessage?.text || "";
  if (text) return { type: "text", text };

  return null;
}

async function sendContentToGroup(sock, groupId, content) {
  if (content.type === "image") {
    await sock.sendMessage(groupId, { image: content.buffer, caption: content.caption });
  } else {
    await sock.sendMessage(groupId, { text: content.text });
  }
}

// ---------- kirim broadcast ke banyak grup sekaligus + catat statistik ----------
async function doBroadcast(sock, content, ids) {
  let sent = 0;
  let failed = 0;
  for (const gid of ids) {
    try {
      await sendContentToGroup(sock, gid, content);
      sent++;
      await delay(1500); // jeda biar ga keblok/spam
    } catch (e) {
      failed++;
      console.error("gagal kirim ke", gid, e.message);
    }
  }
  stats.totalBroadcasts++;
  stats.totalSent += sent;
  stats.totalFailed += failed;
  stats.lastBroadcast = { time: new Date().toISOString(), targetCount: ids.length, sent, failed };
  writeJSON(STATS_FILE, stats);
  return { sent, failed };
}

// ---------- broadcast sekali kirim (reply pesan lalu .bc, ATAU .bc <nama_template>) ----------
async function handleBroadcastOnce(sock, jid, msg, quoted, args) {
  let content = null;
  const tplName = (args[0] || "").toLowerCase();
  if (tplName && templates[tplName]) {
    content = toRuntimeContent(templates[tplName]);
  } else {
    content = await extractContent(sock, quoted, msg);
  }
  if (!content) {
    await sock.sendMessage(jid, { text: "📤 Reply pesan/foto dulu lalu ketik .bc, atau pakai template: .bc <nama_template>" });
    return;
  }
  const ids = getTargetGroupIds();
  if (ids.length === 0) {
    await sock.sendMessage(jid, { text: "⚠️ Belum ada grup. Ketik .listgrup dulu." });
    return;
  }
  const loadingKey = await showLoadingAnimation(sock, jid, "Mengirim broadcast");
  const { sent, failed } = await doBroadcast(sock, content, ids);
  await sock.sendMessage(jid, {
    text: `✅ Terkirim ke ${sent}/${ids.length} grup${failed ? ` (${failed} gagal)` : ""}`,
    edit: loadingKey,
  });
}

// ---------- broadcast otomatis tiap interval (reply pesan lalu .setbc <menit>, ATAU .setbc <menit> <nama_template>) ----------
async function handleSetBc(sock, jid, msg, quoted, args) {
  const loadingKey = await showLoadingAnimation(sock, jid, "Mengatur auto-bc");
  const minutes = parseFloat(args[0]) || config.defaultIntervalMinutes || 1;
  const tplName = (args[1] || "").toLowerCase();

  let savedContent = null;
  if (tplName && templates[tplName]) {
    savedContent = templates[tplName];
  } else {
    const content = await extractContent(sock, quoted, msg);
    if (!content) {
      await sock.sendMessage(jid, {
        text: "⏰ Reply pesan/foto dulu, lalu .setbc <menit>\nAtau pakai template: .setbc <menit> <nama_template>\nContoh: .setbc 30 promo1",
        edit: loadingKey,
      });
      return;
    }
    savedContent = toSavedContent(content);
  }

  bcState = { intervalMinutes: minutes, content: savedContent };
  writeJSON(BC_STATE_FILE, bcState);

  startBroadcastInterval(sock, minutes, savedContent, true, jid, loadingKey);
}

function startBroadcastInterval(sock, minutes, savedContent, notify, jid, loadingKey) {
  if (intervalHandle) clearInterval(intervalHandle);

  const content = toRuntimeContent(savedContent);
  const ms = Math.max(minutes, 0.1) * 60 * 1000;

  intervalHandle = setInterval(async () => {
    const ids = getTargetGroupIds();
    const { sent, failed } = await doBroadcast(sock, content, ids);
    console.log(`[auto-bc] terkirim ke ${sent}/${ids.length} grup${failed ? ` (${failed} gagal)` : ""}`);
  }, ms);

  if (notify && jid) {
    sock.sendMessage(jid, {
      text: `🟢 Auto-bc aktif: tiap ${minutes} menit ke ${getTargetGroupIds().length} grup\n🛑 Ketik .stopbc buat matiin`,
      edit: loadingKey,
    });
  }
}

async function handleStopBc(sock, jid) {
  const loadingKey = await showLoadingAnimation(sock, jid, "Mematikan auto-bc");
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  bcState = null;
  if (fs.existsSync(BC_STATE_FILE)) fs.unlinkSync(BC_STATE_FILE);
  await sock.sendMessage(jid, { text: "🔴 Auto-bc dimatiin", edit: loadingKey });
}

// ---------- pilih target grup ----------
async function handleSetTarget(sock, jid, args) {
  const loadingKey = await showLoadingAnimation(sock, jid, "Mengatur target grup");
  if (args[0] === "all") {
    target = { mode: "all", ids: [] };
    writeJSON(TARGET_FILE, target);
    await sock.sendMessage(jid, { text: "🎯 Target: SEMUA grup", edit: loadingKey });
    return;
  }
  if (args[0] === "cari") {
    const keyword = args.slice(1).join(" ").trim().toLowerCase();
    if (!keyword) {
      await sock.sendMessage(jid, { text: "❌ Format: .setgrup cari <keyword>", edit: loadingKey });
      return;
    }
    const matched = Object.entries(groups)
      .filter(([id, name]) => name.toLowerCase().includes(keyword))
      .map(([id]) => id);
    if (matched.length === 0) {
      await sock.sendMessage(jid, { text: `❌ Tidak ada grup yang cocok dengan "${keyword}"`, edit: loadingKey });
      return;
    }
    target = { mode: "custom", ids: matched };
    writeJSON(TARGET_FILE, target);
    await sock.sendMessage(jid, {
      text: `🎯 Target (via keyword "${keyword}"): ${matched.length} grup\n` + matched.map((id) => "• " + groups[id]).join("\n"),
      edit: loadingKey,
    });
    return;
  }
  // args berupa nomor urut dari .listgrup, atau langsung id dipisah koma
  const ids = args.join(" ").split(",").map((s) => s.trim()).filter(Boolean);
  const valid = ids.filter((id) => groups[id]);
  if (valid.length === 0) {
    await sock.sendMessage(jid, { text: "❌ Format: .setgrup all / .setgrup id1,id2 / .setgrup cari <keyword>\nID bisa dilihat di .listgrup", edit: loadingKey });
    return;
  }
  target = { mode: "custom", ids: valid };
  writeJSON(TARGET_FILE, target);
  await sock.sendMessage(jid, {
    text: `🎯 Target: ${valid.length} grup\n` + valid.map((id) => "• " + groups[id]).join("\n"),
    edit: loadingKey,
  });
}

// ---------- fitur: multi-template pesan ----------
async function handleSaveTemplate(sock, jid, msg, quoted, args) {
  const loadingKey = await showLoadingAnimation(sock, jid, "Menyimpan template");
  const name = (args[0] || "").toLowerCase();
  if (!name) {
    await sock.sendMessage(jid, { text: "📝 Format: reply pesan/foto lalu .savetpl <nama>\nContoh: .savetpl promo1", edit: loadingKey });
    return;
  }
  const content = await extractContent(sock, quoted, msg);
  if (!content) {
    await sock.sendMessage(jid, { text: "📝 Reply pesan/foto dulu, baru ketik .savetpl <nama>", edit: loadingKey });
    return;
  }
  templates[name] = toSavedContent(content);
  writeJSON(TEMPLATES_FILE, templates);
  await sock.sendMessage(jid, {
    text: `✅ Template "*${name}*" tersimpan (${Object.keys(templates).length} template total)\nPakai: .bc ${name} / .setbc <menit> ${name} / .jadwalbc <HH:MM> ${name}`,
    edit: loadingKey,
  });
}

async function handleListTemplate(sock, jid) {
  const loadingKey = await showLoadingAnimation(sock, jid, "Mengambil daftar template");
  const names = Object.keys(templates);
  if (names.length === 0) {
    await sock.sendMessage(jid, { text: "📝 Belum ada template. Reply pesan/foto lalu .savetpl <nama> buat nyimpen.", edit: loadingKey });
    return;
  }
  let text = "📝 *Daftar Template*\n\n";
  names.forEach((n) => {
    const t = templates[n];
    text += `• *${n}* (${t.type === "image" ? "🖼️ foto" : "💬 teks"})\n`;
  });
  text += "\n💡 Hapus: .deltpl <nama>";
  await sock.sendMessage(jid, { text, edit: loadingKey });
}

async function handleDeleteTemplate(sock, jid, args) {
  const loadingKey = await showLoadingAnimation(sock, jid, "Menghapus template");
  const name = (args[0] || "").toLowerCase();
  if (!name || !templates[name]) {
    await sock.sendMessage(jid, { text: "❌ Template tidak ditemukan. Cek .listtpl dulu.", edit: loadingKey });
    return;
  }
  delete templates[name];
  writeJSON(TEMPLATES_FILE, templates);
  await sock.sendMessage(jid, { text: `🗑️ Template "*${name}*" dihapus`, edit: loadingKey });
}

// ---------- fitur: statistik pengiriman broadcast ----------
// ---------- fitur: .qc — bikin stiker teks (background putih, font hitam) ----------
async function handleQuickChatSticker(sock, jid, msg, quoted, args) {
  if (!Jimp) {
    await sock.sendMessage(jid, {
      text: "⚠️ Fitur .qc butuh library tambahan. Jalanin dulu di folder bot:\nnpm install jimp\nlalu restart bot (./stop.sh && ./start.sh).",
    });
    return;
  }

  let text = "";
  if (quoted) {
    text = quoted.conversation || quoted.extendedTextMessage?.text || "";
  }
  if (!text) text = args.join(" ");
  if (!text) {
    await sock.sendMessage(jid, { text: "🖼️ Reply pesan teks lalu .qc, atau .qc <teks langsung>\nContoh: .qc Halo semua!" });
    return;
  }

  const loadingKey = await showLoadingAnimation(sock, jid, "Membuat stiker");

  try {
    const size = 512;
    const image = await new Jimp(size, size, 0xffffffff); // kanvas putih polos

    let font;
    if (text.length <= 20) font = await Jimp.loadFont(Jimp.FONT_SANS_64_BLACK);
    else if (text.length <= 60) font = await Jimp.loadFont(Jimp.FONT_SANS_32_BLACK);
    else font = await Jimp.loadFont(Jimp.FONT_SANS_16_BLACK);

    image.print(
      font,
      20,
      20,
      { text, alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER, alignmentY: Jimp.VERTICAL_ALIGN_MIDDLE },
      size - 40,
      size - 40
    );

    const buffer = await image.getBufferAsync(Jimp.MIME_PNG);

    try {
      // WA idealnya butuh WebP buat stiker; sebagian versi Baileys bisa nerima PNG langsung
      await sock.sendMessage(jid, { sticker: buffer });
      await sock.sendMessage(jid, { text: "✅ Stiker terkirim", edit: loadingKey });
    } catch (stickerErr) {
      // Kalau gagal (butuh WebP asli), fallback kirim sebagai gambar biasa biar tetep kepake
      await sock.sendMessage(jid, {
        image: buffer,
        caption: "🖼️ Dikirim sebagai gambar (stiker WebP butuh library tambahan seperti 'sharp' yang belum terpasang)",
      });
      await sock.sendMessage(jid, { text: "⚠️ Gagal kirim sebagai stiker asli, dikirim sebagai gambar biasa.", edit: loadingKey });
    }
  } catch (e) {
    console.error(e);
    await sock.sendMessage(jid, { text: "❌ Gagal bikin stiker: " + e.message, edit: loadingKey });
  }
}

// ---------- fitur: testimoni otomatis dari foto bukti transfer ----------

// atur channel WA tujuan auto-post (support link https://whatsapp.com/channel/xxxx ATAU JID langsung)
async function handleSetTestiChannel(sock, jid, args) {
  const loadingKey = await showLoadingAnimation(sock, jid, "Mengatur channel tujuan");
  const input = (args[0] || "").trim();
  if (!input) {
    await sock.sendMessage(jid, {
      text:
        "📣 Format: .setchannel <link_channel_atau_JID>\n" +
        "Contoh: .setchannel https://whatsapp.com/channel/xxxxxxxx\n" +
        "Atau langsung JID: .setchannel 1234567890@newsletter\n" +
        "⚠️ Bot (nomor yang login) harus jadi admin channel-nya biar bisa auto-post.\n" +
        "🛑 Matiin auto-post: .setchannel off",
      edit: loadingKey,
    });
    return;
  }
  if (input.toLowerCase() === "off") {
    testiChannel = { jid: "" };
    writeJSON(TESTI_CHANNEL_FILE, testiChannel);
    await sock.sendMessage(jid, { text: "🛑 Auto-post testimoni ke channel dimatiin.", edit: loadingKey });
    return;
  }
  let channelJid = null;
  try {
    if (input.includes("whatsapp.com/channel/")) {
      const inviteCode = input.split("whatsapp.com/channel/")[1].split(/[/?]/)[0];
      const meta = await sock.newsletterMetadata("invite", inviteCode);
      channelJid = meta?.id || null;
    } else if (input.endsWith("@newsletter")) {
      channelJid = input;
    }
  } catch (e) {
    await sock.sendMessage(jid, {
      text: "❌ Gagal ambil info channel: " + e.message + "\nPastikan link/JID bener dan versi Baileys di project ini masih support newsletter/channel.",
      edit: loadingKey,
    });
    return;
  }
  if (!channelJid) {
    await sock.sendMessage(jid, {
      text: "❌ Link/JID channel nggak valid. Pakai link https://whatsapp.com/channel/... atau JID yang diakhiri @newsletter",
      edit: loadingKey,
    });
    return;
  }
  testiChannel = { jid: channelJid };
  writeJSON(TESTI_CHANNEL_FILE, testiChannel);
  await sock.sendMessage(jid, {
    text: `✅ Channel auto-post testimoni diset ke:\n${channelJid}\nSetiap .testi baru bakal otomatis diposting ke sini juga.`,
    edit: loadingKey,
  });
}

// generate gambar testimoni: foto asli + footer info barang/tanggal/nominal
async function generateTestiImage(buffer, barang, tanggal, nominal) {
  if (!Jimp) return null;
  const photo = await Jimp.read(buffer);
  const width = 800;
  photo.resize(width, Jimp.AUTO);
  const footerHeight = 190;
  const canvas = new Jimp(width, photo.bitmap.height + footerHeight, 0xffffffff);
  canvas.composite(photo, 0, 0);

  const fontBig = await Jimp.loadFont(Jimp.FONT_SANS_32_BLACK);
  const fontSmall = await Jimp.loadFont(Jimp.FONT_SANS_16_BLACK);

  let y = photo.bitmap.height + 15;
  // catatan: font bawaan Jimp nggak punya glyph emoji, jadi di dalam GAMBAR pakai simbol biasa aja
  // (emoji tetap muncul normal di caption chat WA, itu dirender WA sendiri bukan Jimp)
  canvas.print(fontBig, 20, y, "TESTIMONI PEMBELIAN");
  y += 48;
  canvas.print(fontSmall, 20, y, `Barang   : ${barang}`);
  y += 28;
  canvas.print(fontSmall, 20, y, `Tanggal  : ${tanggal}`);
  y += 28;
  canvas.print(fontSmall, 20, y, `Nominal  : Rp${Number(nominal || 0).toLocaleString("id-ID")}`);

  return canvas.getBufferAsync(Jimp.MIME_JPEG);
}

// .testi <nama barang>, <tanggal>, <nominal> — reply foto bukti transfer
async function handleAddTesti(sock, jid, msg, quoted, args) {
  const raw = args.join(" ");
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length < 3) {
    await sock.sendMessage(jid, {
      text:
        "🧾 Reply pesan yang berisi FOTO bukti transfer, lalu:\n" +
        ".testi <nama barang>, <tanggal>, <nominal>\n" +
        "Contoh: .testi Sepatu Lari, 3 September 2026, 250000",
    });
    return;
  }
  if (!quoted || !quoted.imageMessage) {
    await sock.sendMessage(jid, { text: "🧾 Reply pesan yang berisi FOTO bukti transfer dulu, baru ketik .testi <barang>, <tanggal>, <nominal>" });
    return;
  }

  const [barang, tanggal, nominalRaw] = parts;
  const nominal = nominalRaw.replace(/[^0-9]/g, "");

  const loadingKey = await showLoadingAnimation(sock, jid, "Membuat testimoni");

  const content = await extractContent(sock, quoted, msg);
  if (!content || content.type !== "image") {
    await sock.sendMessage(jid, { text: "❌ Gagal ambil foto dari pesan yang di-reply.", edit: loadingKey });
    return;
  }

  let finalBuffer = content.buffer;
  try {
    const generated = await generateTestiImage(content.buffer, barang, tanggal, nominal);
    if (generated) finalBuffer = generated;
  } catch (e) {
    console.error("gagal generate testi image:", e.message);
    // kalau gagal generate (misal Jimp belum terinstall), tetep lanjut pakai foto asli
  }

  const caption =
    `✅ *TESTIMONI PEMBELIAN*\n\n` +
    `🛍️ Barang : *${barang}*\n` +
    `📅 Tanggal : *${tanggal}*\n` +
    `💰 Nominal : *Rp${Number(nominal || 0).toLocaleString("id-ID")}*\n\n` +
    `Terima kasih sudah belanja! 🙏`;

  const id = Date.now().toString(36);
  testimonials.push({
    id,
    barang,
    tanggal,
    nominal,
    imageBase64: finalBuffer.toString("base64"),
    time: new Date().toISOString(),
  });
  writeJSON(TESTI_FILE, testimonials);

  await sock.sendMessage(jid, { image: finalBuffer, caption, edit: loadingKey });

  if (testiChannel.jid) {
    try {
      await sock.sendMessage(testiChannel.jid, { image: finalBuffer, caption });
      await sock.sendMessage(jid, { text: "📣 Testimoni otomatis diposting ke channel juga ✅" });
    } catch (e) {
      console.error("gagal auto-post testi ke channel:", e); // log lengkap buat debugging
      await sock.sendMessage(jid, {
        text: `⚠️ Testimoni tersimpan, tapi gagal auto-post ke channel: ${e.message}\nCek lagi .setchannel dan pastikan bot masih admin channel-nya.`,
      });
    }
  }
}

async function handleListTesti(sock, jid) {
  const loadingKey = await showLoadingAnimation(sock, jid, "Mengambil daftar testimoni");
  if (testimonials.length === 0) {
    await sock.sendMessage(jid, { text: "🧾 Belum ada testimoni. Reply foto bukti transfer lalu .testi <barang>, <tanggal>, <nominal>", edit: loadingKey });
    return;
  }
  let text = "🧾 *Daftar Testimoni*\n\n";
  testimonials.slice(-20).reverse().forEach((t) => {
    text += `• ID: *${t.id}* — ${t.barang}\n  📅 ${t.tanggal} · 💰 Rp${Number(t.nominal || 0).toLocaleString("id-ID")}\n\n`;
  });
  text += `📊 Total tersimpan: *${testimonials.length}* (20 terbaru ditampilkan)\n🗑️ Hapus: .deltesti <ID>`;
  await sock.sendMessage(jid, { text, edit: loadingKey });
}

async function handleDeleteTesti(sock, jid, args) {
  const loadingKey = await showLoadingAnimation(sock, jid, "Menghapus testimoni");
  const id = args[0];
  const idx = testimonials.findIndex((t) => t.id === id);
  if (idx === -1) {
    await sock.sendMessage(jid, { text: "❌ Testimoni tidak ditemukan. Cek .listtesti buat lihat ID-nya.", edit: loadingKey });
    return;
  }
  testimonials.splice(idx, 1);
  writeJSON(TESTI_FILE, testimonials);
  await sock.sendMessage(jid, { text: `🗑️ Testimoni *${id}* dihapus`, edit: loadingKey });
}

async function handleStats(sock, jid) {
  const loadingKey = await showLoadingAnimation(sock, jid, "Mengambil statistik");
  const last = stats.lastBroadcast;
  let lastText = "Belum pernah broadcast";
  if (last) {
    const d = new Date(last.time);
    const tanggal = d.toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" });
    lastText = `${tanggal}\n  Target: ${last.targetCount} grup, sukses ${last.sent}, gagal ${last.failed}`;
  }
  const text = `📊 *Statistik Broadcast*

Total broadcast dikirim: *${stats.totalBroadcasts}* kali
Total pesan sukses: *${stats.totalSent}*
Total pesan gagal: *${stats.totalFailed}*

🕐 *Broadcast terakhir:*
  ${lastText}`;
  await sock.sendMessage(jid, { text, edit: loadingKey });
}

// ---------- fitur: jadwal broadcast harian di jam tertentu ----------
async function handleSetSchedule(sock, jid, msg, quoted, args) {
  const loadingKey = await showLoadingAnimation(sock, jid, "Membuat jadwal");
  const time = args[0];
  if (!time || !/^([01]\d|2[0-3]):([0-5]\d)$/.test(time)) {
    await sock.sendMessage(jid, { text: "⏰ Format: .jadwalbc <HH:MM> [nama_template]\nContoh: .jadwalbc 08:00 promo1\nAtau reply pesan/foto: .jadwalbc 08:00", edit: loadingKey });
    return;
  }
  const tplName = (args[1] || "").toLowerCase();
  let savedContent = null;
  if (tplName) {
    if (!templates[tplName]) {
      await sock.sendMessage(jid, { text: `❌ Template "${tplName}" tidak ditemukan. Cek .listtpl`, edit: loadingKey });
      return;
    }
    savedContent = templates[tplName];
  } else {
    const content = await extractContent(sock, quoted, msg);
    if (!content) {
      await sock.sendMessage(jid, { text: "⏰ Reply pesan/foto dulu, atau pakai nama template: .jadwalbc 08:00 promo1", edit: loadingKey });
      return;
    }
    savedContent = toSavedContent(content);
  }

  const id = Date.now().toString(36);
  schedules.push({ id, time, content: savedContent, templateName: tplName || null });
  writeJSON(SCHEDULE_FILE, schedules);
  await sock.sendMessage(jid, {
    text: `🗓️ Jadwal dibuat! ID: *${id}*\nSetiap hari jam *${time}* ke ${getTargetGroupIds().length} grup (sesuai target aktif)\n🛑 Hapus: .deljadwal ${id}`,
    edit: loadingKey,
  });
}

async function handleListSchedule(sock, jid) {
  const loadingKey = await showLoadingAnimation(sock, jid, "Mengambil daftar jadwal");
  if (schedules.length === 0) {
    await sock.sendMessage(jid, { text: "🗓️ Belum ada jadwal broadcast. Bikin dengan .jadwalbc <HH:MM>", edit: loadingKey });
    return;
  }
  let text = "🗓️ *Daftar Jadwal Broadcast*\n\n";
  schedules.forEach((s) => {
    text += `• ID: *${s.id}* — jam *${s.time}* setiap hari\n  ${s.templateName ? `Template: ${s.templateName}` : `Konten: ${s.content.type === "image" ? "🖼️ foto" : "💬 teks"}`}\n\n`;
  });
  text += "🛑 Hapus: .deljadwal <ID>";
  await sock.sendMessage(jid, { text, edit: loadingKey });
}

async function handleDeleteSchedule(sock, jid, args) {
  const loadingKey = await showLoadingAnimation(sock, jid, "Menghapus jadwal");
  const id = args[0];
  const idx = schedules.findIndex((s) => s.id === id);
  if (idx === -1) {
    await sock.sendMessage(jid, { text: "❌ Jadwal tidak ditemukan. Cek .listjadwal buat lihat ID-nya.", edit: loadingKey });
    return;
  }
  schedules.splice(idx, 1);
  writeJSON(SCHEDULE_FILE, schedules);
  await sock.sendMessage(jid, { text: `🗑️ Jadwal *${id}* dihapus`, edit: loadingKey });
}

function startScheduleChecker(sock) {
  setInterval(async () => {
    if (schedules.length === 0) return;
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const currentTime = `${hh}:${mm}`;
    const dateKey = now.toISOString().slice(0, 10);

    for (const sch of schedules) {
      if (sch.time !== currentTime) continue;
      const fireKey = `${sch.id}_${dateKey}_${currentTime}`;
      if (scheduleFiredKeys[fireKey]) continue;
      scheduleFiredKeys[fireKey] = true;

      const ids = getTargetGroupIds();
      if (ids.length === 0) continue;
      const runtimeContent = toRuntimeContent(sch.content);
      const { sent, failed } = await doBroadcast(sock, runtimeContent, ids);
      console.log(`[jadwal] ${sch.id} (${sch.time}) terkirim ke ${sent}/${ids.length} grup${failed ? ` (${failed} gagal)` : ""}`);
    }
  }, 20000); // cek tiap 20 detik
}

const MENU_HEADER_IMAGE = "./menu-header.jpg"; // taruh foto di sini (jpg/png) buat header menu, opsional

async function sendMenu(sock, jid) {
  const loadingKey = await showLoadingAnimation(sock, jid, "Menyiapkan menu");
  const p = config.prefix;
  const totalGrup = Object.keys(groups).length;
  const targetInfo = target.mode === "all" ? "Semua grup" : `${target.ids.length} grup terpilih`;
  const bcStatus = bcState ? `🟢 Aktif (tiap ${bcState.intervalMinutes} menit)` : "🔴 Nonaktif";
  const totalTpl = Object.keys(templates).length;
  const totalJadwal = schedules.length;
  const totalTesti = testimonials.length;
  const channelStatus = testiChannel.jid ? "🟢 Aktif" : "🔴 Belum diset";

  const menuList = MENU_ITEMS.map((m) => `*${m.num}.* ${m.emoji} *${m.title}*\n     ${m.hint}`).join(`\n\n`);

  const text = `╭───「 🤖 *BOT BROADCAST WA* 」
│ Prefix: *${p}*
│ Grup tersimpan: *${totalGrup}*
│ Target aktif: *${targetInfo}*
│ Auto-broadcast: ${bcStatus}
│ Template tersimpan: *${totalTpl}*
│ Jadwal aktif: *${totalJadwal}*
│ Testimoni tersimpan: *${totalTesti}*
│ Auto-post channel: ${channelStatus}
╰───────────────

📋 *DAFTAR MENU*
💡 Ketik ${p}<command> sesuai daftar di bawah

${menuList}`;

  // Kalau ada foto header di MENU_HEADER_IMAGE, kirim sebagai gambar + caption menu
  // (pesan loading di-edit jadi teks pendek dulu, karena WA nggak bisa edit teks jadi gambar).
  // Kalau nggak ada foto, loading langsung di-edit jadi menu teksnya.
  if (fs.existsSync(MENU_HEADER_IMAGE)) {
    await sock.sendMessage(jid, { text: "✅ Menu siap", edit: loadingKey });
    await sock.sendMessage(jid, { image: fs.readFileSync(MENU_HEADER_IMAGE), caption: text });
  } else {
    await sock.sendMessage(jid, { text, edit: loadingKey });
  }
}

function delay(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

startBot();
