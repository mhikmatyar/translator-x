const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// Available free models on OpenRouter
const MODELS = {
  "auto": { id: "openrouter/free", name: "Auto (Free)", vision: true },
  "gemma-4": { id: "google/gemma-4-31b-it:free", name: "Gemma 4 31B", vision: true },
  "gemma-4-small": { id: "google/gemma-4-26b-a4b-it:free", name: "Gemma 4 26B", vision: true },
  "deepseek-v3": { id: "deepseek/deepseek-chat-v3-0324:free", name: "DeepSeek V3", vision: false },
};

const DEFAULT_MODEL = "auto";


// User preferences (in-memory, resets on cold start)
const userPrefs = {};

function getPrefs(userId) {
  if (!userPrefs[userId]) {
    userPrefs[userId] = { lang: "Indonesian", style: "Witty & Engaging", model: DEFAULT_MODEL };
  }
  return userPrefs[userId];
}

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
    try {
      const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;
      if (chatId) {
        await sendTelegram("sendMessage", { chat_id: chatId, text: `❌ Error: ${error.message}` });
      }
    } catch (e) {
      console.error("Failed to send error notification:", e);
    }
  }

  return res.status(200).json({ ok: true });
}

async function handleMessage(message) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = message.text || message.caption || "";
  const command = text.split("@")[0].split(" ")[0].toLowerCase();

  // Handle Commands
  if (command === "/start") {
    const prefs = getPrefs(userId);
    return sendTelegram("sendMessage", {
      chat_id: chatId,
      text: `👋 Halo! Saya adalah X-Reply Bot.\n\nKirimkan saya teks post, screenshot, atau video dari X, dan saya akan memberikan saran balasan yang menarik.\n\n📌 Model aktif: ${MODELS[prefs.model].name}\n\nGunakan:\n/settings - Atur bahasa & gaya\n/model - Pilih AI model`,
    });
  }

  if (command === "/settings") {
    return sendSettings(chatId, userId);
  }

  if (command === "/model") {
    return sendModelPicker(chatId, userId);
  }

  // Show Loading
  const loadingMsg = await sendTelegram("sendMessage", {
    chat_id: chatId,
    text: "⏳ Sedang memproses konteks...",
  });
  const loadingMsgId = loadingMsg?.result?.message_id;

  try {
    const prefs = getPrefs(userId);
    const selectedModel = MODELS[prefs.model] || MODELS[DEFAULT_MODEL];

    // Build message content parts (OpenAI format)
    const contentParts = [];

    if (text) {
      contentParts.push({ type: "text", text: `Konteks/Post: ${text}` });
    }

    // Handle media
    if (message.photo && selectedModel.vision) {
      const fileId = message.photo[message.photo.length - 1].file_id;
      const base64 = await getFileBase64(fileId);
      contentParts.push({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${base64}` }
      });
    } else if (message.video && selectedModel.vision) {
      // For video, extract description via text
      contentParts.push({ type: "text", text: "[Video dikirim - mohon analisis berdasarkan konteks teks yang diberikan]" });
    } else if (message.document && selectedModel.vision) {
      const mime = message.document.mime_type || "";
      if (mime.startsWith("image/")) {
        const fileId = message.document.file_id;
        const base64 = await getFileBase64(fileId);
        contentParts.push({
          type: "image_url",
          image_url: { url: `data:${mime};base64,${base64}` }
        });
      }
    }

    if (contentParts.length === 0) {
      if (loadingMsgId) return editTelegram(chatId, loadingMsgId, "Silakan kirim pesan teks, foto, atau video.");
      return;
    }

    // Call OpenRouter
    const systemPrompt = `Anda adalah pakar media sosial X (Twitter). 
Tugas Anda adalah memberikan saran balasan (reply) yang masuk akal, menarik, dan sesuai konteks untuk post yang dikirimkan.
Gaya bahasa: ${prefs.style}
Bahasa balasan: ${prefs.lang}

Berikan 3 pilihan balasan:
1. Singkat & Padat
2. Menarik/Witty
3. Diskusi/Pertanyaan

Sertakan juga alasan singkat mengapa balasan tersebut bagus.
Jika bahasa balasan BUKAN Indonesian, tambahkan terjemahan ke Bahasa Indonesia di bawah setiap balasan dengan format:
(Terjemahan: ...)
Jangan gunakan format Markdown yang kompleks. Gunakan teks biasa atau emoji saja.`;

    const response = await callOpenRouter(selectedModel.id, systemPrompt, contentParts);

    // Send Response
    const replyText = `🤖 ${selectedModel.name}\n\n${response}`;
    if (loadingMsgId) {
      await editTelegram(chatId, loadingMsgId, replyText);
    }

  } catch (error) {
    console.error("AI Error:", error);
    const errMsg = `❌ Error: ${error.message || "Unknown error"}`;
    if (loadingMsgId) {
      await editTelegram(chatId, loadingMsgId, errMsg);
    } else {
      await sendTelegram("sendMessage", { chat_id: chatId, text: errMsg });
    }
  }
}

async function handleCallback(callback) {
  const chatId = callback.message.chat.id;
  const userId = callback.from.id;
  const data = callback.data;
  const prefs = getPrefs(userId);

  if (data.startsWith("lang_")) {
    prefs.lang = data.replace("lang_", "");
    await sendTelegram("answerCallbackQuery", { callback_query_id: callback.id, text: `Bahasa: ${prefs.lang}` });
    await editSettingsMsg(chatId, callback.message.message_id, userId);
  } else if (data.startsWith("style_")) {
    prefs.style = data.replace("style_", "");
    await sendTelegram("answerCallbackQuery", { callback_query_id: callback.id, text: `Gaya: ${prefs.style}` });
    await editSettingsMsg(chatId, callback.message.message_id, userId);
  } else if (data.startsWith("model_")) {
    const modelKey = data.replace("model_", "");
    if (MODELS[modelKey]) {
      prefs.model = modelKey;
      await sendTelegram("answerCallbackQuery", { callback_query_id: callback.id, text: `Model: ${MODELS[modelKey].name}` });
      await editModelMsg(chatId, callback.message.message_id, userId);
    }
  }
}

// Settings UI
async function sendSettings(chatId, userId) {
  const prefs = getPrefs(userId);
  return sendTelegram("sendMessage", {
    chat_id: chatId,
    text: `⚙️ Pengaturan Balasan\n\n🌐 Bahasa: ${prefs.lang}\n🎭 Gaya: ${prefs.style}\n🤖 Model: ${MODELS[prefs.model].name}`,
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

async function editSettingsMsg(chatId, messageId, userId) {
  const prefs = getPrefs(userId);
  return sendTelegram("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: `⚙️ Pengaturan Balasan\n\n🌐 Bahasa: ${prefs.lang}\n🎭 Gaya: ${prefs.style}\n🤖 Model: ${MODELS[prefs.model].name}`,
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

// Model Picker UI
async function sendModelPicker(chatId, userId) {
  const prefs = getPrefs(userId);
  const buttons = Object.entries(MODELS).map(([key, m]) => {
    const active = prefs.model === key ? "✅ " : "";
    const vision = m.vision ? "👁" : "";
    return { text: `${active}${m.name} ${vision}`, callback_data: `model_${key}` };
  });
  // 2 buttons per row
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2));
  }

  return sendTelegram("sendMessage", {
    chat_id: chatId,
    text: `🤖 Pilih AI Model\n\nModel aktif: ${MODELS[prefs.model].name}\n👁 = mendukung analisis gambar`,
    reply_markup: { inline_keyboard: rows }
  });
}

async function editModelMsg(chatId, messageId, userId) {
  const prefs = getPrefs(userId);
  const buttons = Object.entries(MODELS).map(([key, m]) => {
    const active = prefs.model === key ? "✅ " : "";
    const vision = m.vision ? "👁" : "";
    return { text: `${active}${m.name} ${vision}`, callback_data: `model_${key}` };
  });
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2));
  }

  return sendTelegram("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: `🤖 Pilih AI Model\n\nModel aktif: ${MODELS[prefs.model].name}\n👁 = mendukung analisis gambar`,
    reply_markup: { inline_keyboard: rows }
  });
}

// OpenRouter API
async function callOpenRouter(modelId, systemPrompt, contentParts) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://translator-x-vert.vercel.app",
      "X-Title": "X Reply Bot"
    },
    body: JSON.stringify({
      model: modelId,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: contentParts }
      ],
      max_tokens: 1500,
    })
  });

  const data = await res.json();

  if (data.error) {
    throw new Error(data.error.message || JSON.stringify(data.error));
  }

  return data.choices?.[0]?.message?.content || "Tidak ada respons dari model.";
}

// Telegram Helpers
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
  });
}

async function getFileBase64(fileId) {
  const fileInfoRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`);
  const fileInfo = await fileInfoRes.json();
  const filePath = fileInfo.result.file_path;

  const fileRes = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`);
  const buffer = await fileRes.arrayBuffer();
  return Buffer.from(buffer).toString('base64');
}
