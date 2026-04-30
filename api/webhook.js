import { GoogleGenerativeAI } from "@google/generative-ai";
import fetch from "node-fetch";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;

// User preferences (Temporary in-memory, will reset on cold start)
// For production, use Redis or a database.
const userPrefs = {};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  const update = req.body;

  try {
    if (update.message) {
      await handleMessage(update.message);
    } else if (update.callback_query) {
      await handleCallback(update.callback_query);
    }
  } catch (error) {
    console.error("Error handling update:", error);
  }

  return res.status(200).json({ ok: true });
}

async function handleMessage(message) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = message.text || message.caption || "";

  // 1. Handle Commands
  if (text === "/start") {
    return sendTelegram("sendMessage", {
      chat_id: chatId,
      text: "👋 Halo! Saya adalah X-Reply Bot.\n\nKirimkan saya link X, teks post, screenshot, atau video dari X, dan saya akan memberikan saran balasan yang menarik.\n\nGunakan /settings untuk mengatur bahasa dan gaya bahasa.",
    });
  }

  if (text === "/settings") {
    return sendSettings(chatId, userId);
  }

  // 2. Show Loading State
  const loadingMsg = await sendTelegram("sendMessage", {
    chat_id: chatId,
    text: "⏳ Sedang memproses konteks...",
  });

  try {
    // 3. Prepare Gemini Parts
    const parts = [];
    
    // Add text if available
    if (text) {
      parts.push({ text: `Konteks/Post: ${text}` });
    }

    // Add Media if available
    if (message.photo) {
      const fileId = message.photo[message.photo.length - 1].file_id;
      const mediaData = await getFileData(fileId);
      parts.push(mediaData);
    } else if (message.video) {
      const fileId = message.video.file_id;
      const mediaData = await getFileData(fileId);
      parts.push(mediaData);
    }

    if (parts.length === 0) {
      return editTelegram(chatId, loadingMsg.result.message_id, "Silakan kirim pesan teks, foto, atau video.");
    }

    // 4. Get User Prefs
    const prefs = userPrefs[userId] || { lang: "Indonesian", style: "Witty & Engaging" };

    // 5. Generate Response with Gemini
    const model = genAI.getGenerativeModel({ 
      model: "gemini-1.5-flash", // Use flash for speed
      systemInstruction: `Anda adalah pakar media sosial X (Twitter). 
Tugas Anda adalah memberikan saran balasan (reply) yang masuk akal, menarik, dan sesuai konteks untuk post yang dikirimkan.
Gaya bahasa: ${prefs.style}
Bahasa balasan: ${prefs.lang}

Berikan 3 pilihan balasan:
1. Singkat & Padat
2. Menarik/Witty
3. Diskusi/Pertanyaan

Sertakan juga alasan singkat mengapa balasan tersebut bagus.`
    });

    const result = await model.generateContent({ contents: [{ role: "user", parts }] });
    const responseText = result.response.text();

    // 6. Send Response
    await editTelegram(chatId, loadingMsg.result.message_id, responseText);

  } catch (error) {
    console.error("Gemini Error:", error);
    await editTelegram(chatId, loadingMsg.result.message_id, "Maaf, terjadi kesalahan saat memproses permintaan Anda.");
  }
}

async function handleCallback(callback) {
  const chatId = callback.message.chat.id;
  const userId = callback.from.id;
  const data = callback.data;

  if (!userPrefs[userId]) userPrefs[userId] = { lang: "Indonesian", style: "Witty & Engaging" };

  if (data.startsWith("lang_")) {
    userPrefs[userId].lang = data.replace("lang_", "");
    await sendTelegram("answerCallbackQuery", { callback_query_id: callback.id, text: `Bahasa diatur ke: ${userPrefs[userId].lang}` });
  } else if (data.startsWith("style_")) {
    userPrefs[userId].style = data.replace("style_", "");
    await sendTelegram("answerCallbackQuery", { callback_query_id: callback.id, text: `Gaya diatur ke: ${userPrefs[userId].style}` });
  }

  // Update settings message
  await editSettings(chatId, callback.message.message_id, userId);
}

async function sendSettings(chatId, userId) {
  const prefs = userPrefs[userId] || { lang: "Indonesian", style: "Witty & Engaging" };
  
  return sendTelegram("sendMessage", {
    chat_id: chatId,
    text: `⚙️ *Pengaturan Balasan*\n\nBahasa saat ini: ${prefs.lang}\nGaya saat ini: ${prefs.style}`,
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🇮🇩 Indo", callback_data: "lang_Indonesian" },
          { text: "🇺🇸 English", callback_data: "lang_English" },
          { text: "🇯🇵 Japan", callback_data: "lang_Japanese" }
        ],
        [
          { text: "🔥 Witty", callback_data: "style_Witty & Engaging" },
          { text: "👔 Prof", callback_data: "style_Professional" },
          { text: "💀 Sarcastic", callback_data: "style_Sarcastic" }
        ]
      ]
    }
  });
}

async function editSettings(chatId, messageId, userId) {
  const prefs = userPrefs[userId] || { lang: "Indonesian", style: "Witty & Engaging" };
  
  return sendTelegram("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: `⚙️ *Pengaturan Balasan*\n\nBahasa saat ini: ${prefs.lang}\nGaya saat ini: ${prefs.style}`,
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🇮🇩 Indo", callback_data: "lang_Indonesian" },
          { text: "🇺🇸 English", callback_data: "lang_English" },
          { text: "🇯🇵 Japan", callback_data: "lang_Japanese" }
        ],
        [
          { text: "🔥 Witty", callback_data: "style_Witty & Engaging" },
          { text: "👔 Prof", callback_data: "style_Professional" },
          { text: "💀 Sarcastic", callback_data: "style_Sarcastic" }
        ]
      ]
    }
  });
}

// Helpers
async function sendTelegram(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function editTelegram(chatId, messageId, text) {
  return sendTelegram("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: text,
    parse_mode: "Markdown"
  });
}

async function getFileData(fileId) {
  const fileInfoRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`);
  const fileInfo = await fileInfoRes.json();
  const filePath = fileInfo.result.file_path;
  
  const fileRes = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`);
  const buffer = await fileRes.arrayBuffer();
  const base64Data = Buffer.from(buffer).toString('base64');
  
  // Determine mimeType based on extension
  const ext = filePath.split('.').pop().toLowerCase();
  const mimeType = ext === 'mp4' ? 'video/mp4' : 'image/jpeg';

  return {
    inlineData: {
      data: base64Data,
      mimeType: mimeType
    }
  };
}
