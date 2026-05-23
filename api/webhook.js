import axios from "axios";

const shortDictionary = {
  "오": "โอ",
  "아": "อา",
  "어": "อืม",
  "응": "อืม",
  "네": "ครับ",
  "넵": "ครับ",
  "넹": "ครับ",
  "ㅇㅋ": "โอเค",
  "오케이": "โอเค",
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
  const hasEnglish = /[a-zA-Z]/.test(text);

  if (hasThai) return "th";
  if (hasKorean) return "ko";
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
      },
      timeout: 10000
    }
  );
}

async function askOpenAI(systemPrompt, text) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      temperature: 0.2,
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

async function translateWithOpenAI(text) {
  const dictionaryResult = getDictionaryTranslation(text);
  if (dictionaryResult) return dictionaryResult;

  const lang = detectLanguage(text);

  if (lang === "ko") {
    return await askOpenAI(`
You are a Korean to Thai translator for real LINE chat conversations.

Rules:
- Translate Korean into natural Thai.
- Use Thai MALE speaking style.
- NEVER use female particles such as:
ค่ะ, คะ, จ๊ะ, จ้า, ค่า, นะคะ, นะค่ะ.
- Use ครับ ONLY when it sounds natural.
- Do NOT force polite particles on every sentence.
- Casual chat, laughter, reactions, short comments should often omit ครับ.
- Preserve English brand/app names like LINE, Facebook, Instagram, Boss.
- Convert Korean laughter like ㅋㅋ or ㅎㅎ into 555.
- Keep the tone short and natural like real Thai LINE chat.
- Do not explain.
- Output only translated Thai text.
`, text);
  }

  if (lang === "th") {
    return await askOpenAI(`
You are a Thai to Korean translator for LINE chat.

Rules:
- Translate Thai into natural Korean.
- Preserve English app and brand names.
- Keep the tone casual and concise.
- Output only translated Korean text.
`, text);
  }

  if (lang === "en") {
    const korean = await askOpenAI(`
Translate English into natural Korean.
Output only Korean translation.
`, text);

    const thai = await askOpenAI(`
Translate English into natural Thai male speech style.
Do not overuse ครับ.
Output only Thai translation.
`, text);

    return `KR: ${korean}\nTH: ${thai}`;
  }

  return text;
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
      console.error("Webhook Error:", error?.message || error);

      try {
        if (event.replyToken) {
          await replyToLine(
            event.replyToken,
            "번역 중 오류가 발생했습니다."
          );
        }
      } catch (replyError) {
        console.error("LINE Reply Error:", replyError?.response?.data || replyError?.message || replyError);
      }
    }
  }

  return res.status(200).send("OK");
}
