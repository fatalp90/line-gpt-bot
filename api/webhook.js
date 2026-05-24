import axios from "axios";

const shortDictionary = {
  "오": "โอ",
  "아": "อา",
  "어": "อืม",
  "응": "อืมครับ",
  "네": "ครับ",
  "넵": "ครับ",
  "넹": "ครับ",
  "아니요": "ไม่ครับ",
  "맞아요": "ใช่ครับ",
  "네 맞습니다": "ใช่ครับ",
  "ㅇㅋ": "โอเค",
  "오케이": "โอเค",
  "ㅋㅋ": "555",
  "ㅎㅎ": "555"
};

function normalizeText(text) {
  return String(text || "").trim();
}

function isEnglishOnly(text) {
  const clean = normalizeText(text);

  if (!clean) return false;

  const hasKorean = /[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(clean);
  const hasThai = /[\u0E00-\u0E7F]/.test(clean);
  const hasEnglish = /[a-zA-Z]/.test(clean);

  if (!hasEnglish) return false;
  if (hasKorean || hasThai) return false;

  return true;
}

function isDecorationOnly(text) {
  const clean = normalizeText(text);

  if (!clean) return true;

  // 태국어/한국어/숫자가 하나라도 있으면 정상 처리
  if (/[ㄱ-ㅎㅏ-ㅣ가-힣\u0E00-\u0E7F0-9]/.test(clean)) {
    return false;
  }

  // 알파벳 제거 후 특수문자/이모지만 남으면 decoration 판정
  const removedEnglish = clean.replace(/[a-zA-Z]/g, "");

  return !/[ㄱ-ㅎㅏ-ㅣ가-힣\u0E00-\u0E7F0-9]/.test(removedEnglish);
}

function shouldIgnoreMessage(text) {
  const clean = normalizeText(text);

  if (!clean) return true;

  // 1,000,000 포함 메시지는 무시
  if (clean.includes("1,000,000")) return true;

  // 태그/멘션 포함 메시지는 무시
  if (clean.includes("@")) return true;

  // 영어만 있는 메시지는 무시
  if (isEnglishOnly(clean)) return true;

  // 장식/이모지만 있는 메시지는 무시
  if (isDecorationOnly(clean)) return true;

  return false;
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

  if (hasKorean) return "ko";
  if (hasThai) return "th";
  if (hasEnglish) return "en";

  return "unknown";
}

function cleanup(text) {
  return String(text || "")
    .replace(/^(\s*\.\.\.\s*)+/g, "")
    .replace(/^(\s*…\s*)+/g, "")
    .trim();
}

function forceMaleThai(text) {
  let result = String(text || "");

  const replacements = [
    [/นะคะ/g, "ครับ"],
    [/นะค่ะ/g, "ครับ"],
    [/ค่ะ/g, "ครับ"],
    [/คะ/g, "ครับ"],
    [/ค่า/g, "ครับ"],
    [/จ้า/g, "ครับ"],
    [/จ๊ะ/g, "ครับ"],
    [/น้า/g, "ครับ"],
    [/เลยนะ/g, "เลยครับ"],
    [/กันนะ/g, "กันครับ"],
    [/ได้ไหมนะ/g, "ได้ไหมครับ"],
    [/ไหมนะ/g, "ไหมครับ"],
    [/มั้ยนะ/g, "มั้ยครับ"],
    [/นะ$/g, "ครับ"],
    [/นะ([!?？?]*)$/g, "ครับ$1"],
    [/อะ$/g, ""],
    [/อ่ะ$/g, ""],
    [/จัง$/g, ""]
  ];

  for (const [pattern, replacement] of replacements) {
    result = result.replace(pattern, replacement);
  }

  return result.replace(/\s+/g, " ").trim();
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

  if (!response.ok) {
    console.error("OpenAI Error:", JSON.stringify(data));
    throw new Error(data?.error?.message || "OpenAI request failed");
  }

  return cleanup(data?.choices?.[0]?.message?.content || "");
}

async function translateKoToTh(text) {
  const direct = getDictionaryTranslation(text);
  if (direct) return direct;

  const result = await askOpenAI([
    {
      role: "system",
      content: `You are a Korean to Thai translator for LINE chat.

Rules:
- Translate Korean into Thai.
- Preserve the original meaning exactly.
- Do NOT change the intent.
- Do NOT add emotions, reactions, greetings, or context that do not exist.
- Do NOT overly localize.
- Use natural Thai LINE chat wording.
- Avoid textbook/formal Thai expressions.
- Avoid literary expressions like ราตรีสวัสดิ์ครับ.
- Use Thai male speech style.
- NEVER use female particles such as ค่ะ, คะ, จ้า, จ๊ะ, นะคะ.
- Use ครับ only when natural.
- Keep short Korean sentences short.
- Preserve questioning nuance.
- Preserve pressure / serious tone if present.
- Preserve casual tone if present.
- ㅋㅋ or ㅎㅎ should become 555 ONLY if actually present.
- Preserve English app/brand names.

Output only Thai translation.`
    },
    {
      role: "user",
      content: text
    }
  ]);

  return forceMaleThai(result);
}

async function translateThToKo(text) {
  return await askOpenAI([
    {
      role: "system",
      content: `You are a Thai to Korean translator.

Rules:
- Translate Thai into Korean.
- Preserve original meaning and tone.
- Do NOT summarize.
- Do NOT answer the message.
- Preserve awkward or casual chat style if present.
- Keep numbers, IDs, money amounts, and names unchanged.
- Output Korean only.`
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
      if (event.type === "join") {
        await replyToLine(event.replyToken, "번역 봇 연결 완료");
        continue;
      }

      if (event.type !== "message") continue;
      if (event.message.type !== "text") continue;

      // LINE 이모지 포함 메시지는 무시
      if (event.message.emojis?.length > 0) {
        continue;
      }

      const text = normalizeText(event.message.text);
      if (!text) continue;

      // 특정 패턴 메시지는 답장하지 않음
      if (shouldIgnoreMessage(text)) {
        continue;
      }

      const translated = await translateText(text);

      await replyToLine(event.replyToken, translated);

    } catch (error) {
      console.error("Webhook Error:", error?.message || error);

      try {
        if (event.replyToken) {
          await replyToLine(event.replyToken, "번역 오류");
        }
      } catch (replyError) {
        console.error("LINE Reply Error:", replyError?.response?.data || replyError?.message || replyError);
      }
    }
  }

  return res.status(200).send("OK");
}
