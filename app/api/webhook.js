import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

export default async function handler(req, res) {
  if (req.method === 'POST') {
    const { message } = req.body;
    const chatId = message.chat.id;
    const text = message.text;

    // 1. Inisialisasi Model Gemini
    const model = genAI.getGenerativeModel({ 
        model: "gemini-1.5-pro",
        systemInstruction: "Balas dalam bahasa target dan berikan terjemahan Indonesia."
    });

    // 2. Kirim pesan ke Gemini
    const result = await model.generateContent(text);
    const responseText = result.response.text();

    // 3. Kirim balik ke Telegram
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: responseText,
        parse_mode: "Markdown"
      }),
    });

    return res.status(200).json({ ok: true });
  }
}
