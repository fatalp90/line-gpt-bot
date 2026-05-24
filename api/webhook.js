import axios from "axios";

function normalizeText(text) {
  return String(text || "").trim();
}

function shouldIgnoreMessage(text) {
  return String(text || "").includes("1,000,000");
}

function detectLanguage(text) {
  const hasThai = /[\u0E00-\u0E7F]/.test(text);
  const hasKorean = /[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(text);
  const hasEnglish = /[a-zA-Z]/.test(text);

  if (hasKorean) return "ko";
  if (hasThai) return "th";
  if (hasEnglish) return "en";

  return "unknown";
}

async function replyToLine(replyToken, text) {
  return axios.post(
    "https://api.line.me/v2/bot/message/reply",
    {
      replyToken,
      messages: [{ type: "text", text }]
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
}

async function askOpenAI(messages) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      temperature: 0,
      messages
    })
  });

  const data = await response.json();

  return data?.choices?.[0]?.message?.content?.trim() || "";
}

async function translateKoToTh(text) {
  return await askOpenAI([
    {
      role: "system",
      content: `Translate Korean into natural Thai male LINE chat style.

Rules:
- Preserve original meaning.
- No female particles.
- Do not add emotions or extra meaning.
- Do not use formal literary Thai.
- Output Thai only.`
    },
    {
      role: "user",
      content: text
    }
  ]);
}

async function translateThToKo(text) {
  return await askOpenAI([
    {
      role: "system",
      content: `Translate Thai into Korean naturally.
Output Korean only.`
    },
    {
      role: "user",
      content: text
    }
  ]);
}

async function translateText(text) {
  const lang = detectLanguage(text);

  if (lang === "ko") return await translateKoToTh(text);
  if (lang === "th") return await translateThToKo(text);
  if (lang === "en") return text;

  return text;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).send("OK");
  }

  const events = req.body.events || [];

  for (const event of events) {
    try {

      if (event.type !== "message") continue;
      if (event.message.type !== "text") continue;

      // 이모지 메시지 무시
      if (event.message.emojis?.length > 0) {
        continue;
      }

      const text = normalizeText(event.message.text);

      if (!text) continue;

      // 1,000,000 포함 메시지 무시
      if (shouldIgnoreMessage(text)) {
        continue;
      }

      const translated = await translateText(text);

      await replyToLine(event.replyToken, translated);

    } catch (err) {
      console.error(err);
    }
  }

  return res.status(200).send("OK");
}
