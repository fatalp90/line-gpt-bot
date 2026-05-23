import axios from "axios";

const shortDictionary = {
  "오": "โอ",
  "아": "อา",
  "어": "อืม",
  "응": "อืม",
  "네": "ครับ",
  "넵": "ครับ",
  "넹": "ครับ",
  "ㅇㅋ": "โอเคครับ",
  "오케이": "โอเคครับ",
  "알겠습니다": "รับทราบครับ",
  "좋아요": "ได้ครับ",
  "괜찮아요": "ไม่เป็นไรครับ",
  "ㅋㅋ": "555",
  "ㅎㅎ": "555"
};

function normalizeText(text) {
  return text.trim();
}

function getDictionaryTranslation(text) {
  const clean = normalizeText(text);

  if (/^[ㅋㅎ]+$/.test(clean)) return "555";

  return shortDictionary[clean] || null;
}

function detectLanguage(text) {
  const hasThai = /[\u0E00-\u0E7F]/.test(text);
  const hasKorean = /[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(text);

  if (hasThai) return "th";
  if (hasKorean) return "ko";

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
      },
      timeout: 10000
    }
  );
}

async function translateWithOpenAI(text) {
  const dictionaryResult = getDictionaryTranslation(text);
  if (dictionaryResult) return dictionaryResult;

  const lang = detectLanguage(text);

  let systemPrompt = "";

  if (lang === "ko") {
    systemPrompt = `
You are a Korean to Thai translator for LINE chat.

Rules:
- Translate Korean into Thai only.
- Use natural Thai.
- Keep the message concise.
- Do not add explanations.
- Do not add extra context.
- For casual chat, sound natural.
- Use polite male Thai tone only when it fits naturally.
- Output only the translated result.
`;
  } else if (lang === "th") {
    systemPrompt = `
You are a Thai to Korean translator for LINE chat.

Rules:
- Translate Thai into Korean only.
- Keep the message concise.
- Do not add explanations.
- Do not add extra context.
- Output only the translated Korean text.
`;
  } else {
    return text;
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      temperature: 0,
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: text
        }
      ]
    })
  });

  const data = await response.json();

  if (!response.ok) {
    console.error("OpenAI Error:", JSON.stringify(data));
    throw new Error(data?.error?.message || "OpenAI request failed");
  }

  return data.choices?.[0]?.message?.content?.trim() || "번역 실패";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).send("OK");
  }

  const events = req.body.events || [];

  for (const event of events) {
    try {
      if (event.type === "join") {
        await replyToLine(event.replyToken, "번역 봇이 연결되었습니다 :)");
        continue;
      }

      if (event.type !== "message") continue;
      if (event.message.type !== "text") continue;

      const text = event.message.text;

      const translated = await translateWithOpenAI(text);

      await replyToLine(event.replyToken, translated);

    } catch (error) {
      console.error("Webhook Error:", error);

      try {
        await replyToLine(
          event.replyToken,
          "번역 중 오류가 발생했습니다."
        );
      } catch (replyError) {
        console.error("LINE Reply Error:", replyError?.response?.data || replyError);
      }
    }
  }

  return res.status(200).send("OK");
}
