import axios from "axios";

const ignoreKeywords = [
  "1,000,000",
  "Important checking",
  "Check over"
];

const shortDictionary = {
  "오": "โอ",
  "아": "อา",
  "어": "อืม",
  "응": "อืมครับ",
  "네": "ครับ",
  "넵": "ครับ",
  "넹": "ครับ",
  "아니요": "ไม่ครับ",
  "맞아요": "ใช่ครับ"
};

function normalizeText(text) {
  return String(text || "").trim();
}

function containsKorean(text) {
  return /[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(text || "");
}

function containsThai(text) {
  return /[\u0E00-\u0E7F]/.test(text || "");
}

function containsEnglish(text) {
  return /[a-zA-Z]/.test(text || "");
}

function isEnglishOnly(text) {
  const clean = normalizeText(text);
  return containsEnglish(clean) && !containsKorean(clean) && !containsThai(clean);
}

function isDecorationOnly(text) {
  const clean = normalizeText(text);

  if (/[ㄱ-ㅎㅏ-ㅣ가-힣\u0E00-\u0E7F0-9]/.test(clean)) {
    return false;
  }

  const removedEnglish = clean.replace(/[a-zA-Z]/g, "");

  return !/[ㄱ-ㅎㅏ-ㅣ가-힣\u0E00-\u0E7F0-9]/.test(removedEnglish);
}

function shouldIgnoreMessage(text) {
  const clean = normalizeText(text);

  for (const keyword of ignoreKeywords) {
    if (clean.includes(keyword)) return true;
  }

  if (clean.includes("@")) return true;
  if (isEnglishOnly(clean)) return true;
  if (isDecorationOnly(clean)) return true;

  return false;
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
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages
    })
  });

  const data = await response.json();

  return data?.choices?.[0]?.message?.content?.trim() || "";
}

async function translateKoToTh(text) {

  const direct = shortDictionary[text];
  if (direct) return direct;

  return await askOpenAI([
    {
      role: "system",
      content: `Translate Korean into natural Thai LINE chat.

Rules:
- Sound like a real Thai person chatting naturally.
- Do NOT translate too literally.
- Preserve meaning and emotional nuance.
- Slightly naturalize sentence structure into Thai conversational flow.
- Use male polite tone with ครับ naturally.
- NEVER use female particles:
ค่ะ คะ จ้า จ๊ะ ค่า นะคะ นะค่ะ

Additional rules:
- Preserve emotional nuance naturally.
- Keep short Korean messages short.
- Avoid robotic wording.
- ㅋㅋ or ㅎㅎ may become 555 when natural.
- Do not force 555.

Examples:
오늘도 여전히 바쁜 하루네요 ㅋㅋ
-> วันนี้ก็ยังยุ่งเหมือนเดิมเลย 555

우리 일때문에 안좋았던건가요? ㅠㅠ
-> หรือว่าเป็นเพราะเรื่องงานของพวกเราครับ TT

잘자요
-> นอนหลับฝันดีครับ

미안해요 ㅋㅋ
-> ขอโทษครับ 555

Output Thai only.`
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
      content: `Translate Thai into natural Korean.

Rules:
- Output Korean only.
- Preserve casual chat feeling naturally.
- Preserve emotional nuance.
- Keep names, IDs, money, and numbers unchanged.
- Do not summarize.
- Do not answer the message.`
    },
    {
      role: "user",
      content: text
    }
  ]);
}

async function translateText(text) {

  if (containsKorean(text)) {
    return await translateKoToTh(text);
  }

  if (containsThai(text)) {
    return await translateThToKo(text);
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

      if (event.type !== "message") continue;
      if (event.message.type !== "text") continue;

      if (event.message.emojis?.length > 0) continue;

      const text = normalizeText(event.message.text);

      if (!text) continue;

      if (shouldIgnoreMessage(text)) continue;

      const translated = await translateText(text);

      if (!translated) continue;

      await replyToLine(event.replyToken, translated);

    } catch (err) {
      console.error(err);
    }
  }

  return res.status(200).send("OK");
}
