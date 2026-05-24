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

function cleanup(text) {

  return String(text || "")
    .replace(/^(\s*\.\.\.\s*)+/g, "")
    .replace(/^(\s*…\s*)+/g, "")
    .trim();
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
      temperature: 0.12,
      messages
    })
  });

  const data = await response.json();

  if (!response.ok) {
    console.error(data);
    throw new Error("OpenAI Error");
  }

  return cleanup(data?.choices?.[0]?.message?.content || "");
}

async function translateKoToTh(text) {

  const direct = shortDictionary[text];
  if (direct) return direct;

  return await askOpenAI([
    {
      role: "system",
      content: `You are a Korean to Thai LINE chat translator.

Goal:
Translate Korean into NATURAL Thai LINE conversation while preserving ALL original meaning accurately.

VERY IMPORTANT:
- Preserve ALL information exactly.
- NEVER omit words or categories.
- NEVER simplify structured information.
- Preserve subject perspective exactly.
- NEVER change who is doing the action.
- NEVER invent context not written in Korean.

Meaning preservation examples:
신규+기존 총 19명입니다 :)
-> ลูกค้าใหม่+ลูกค้าเก่า รวมทั้งหมด 19 คนครับ :)

DO NOT reduce it to:
-> รวมทั้งหมด 19 คนครับ :)

Korean nuance understanding:
- Understand teasing tone naturally.
- Understand implied Korean conversational nuance.
- Preserve humor and emotional nuance.
- Avoid dictionary-style translation.
- But NEVER add new meaning.

Time rule:
DO NOT add implied time expressions such as:
วันนี้
เมื่อคืน
ตอนนี้
พรุ่งนี้
unless explicitly written in Korean.

Male speech rules:
- Use male polite tone.
- Use ครับ naturally.
- NEVER use female particles:
ค่ะ คะ จ้า จ๊ะ ค่า นะคะ นะค่ะ

Naturalness:
- Sound like a real Thai person chatting naturally.
- Slightly naturalize sentence flow into Thai conversation.
- Avoid robotic translation.
- Keep short messages short.
- Do not overexplain.

Laughter:
- ㅋㅋ or ㅎㅎ may become 555 ONLY when natural.
- Do NOT force 555.

GOOD EXAMPLES:

편하죠?ㅋㅋ
-> สบายใช่ไหมครับ 555

신규+기존 총 19명입니다 :)
-> ลูกค้าใหม่+ลูกค้าเก่า รวมทั้งหมด 19 คนครับ :)

오늘도 여전히 바쁜 하루네요 ㅋㅋ
-> วันวุ่นๆอีกวันเลยครับ 555

우리 일때문에 안좋았던건가요? ㅠㅠ
-> หรือว่าเป็นเพราะเรื่องงานของพวกเราครับ TT

정신 없는 하루를 보내고 긴장이 풀리면서 기절 하셨던것 같아요 ㅋㅋ
-> คงเหนื่อยมากจนหลับไปเลยครับ 555

잘자요
-> นอนหลับฝันดีครับ

입금하세요
-> โอนเงินมาครับ

상환하세요
-> ชำระคืนครับ

왜 안하세요?
-> ทำไมไม่ทำครับ?

할말있나요?
-> มีอะไรจะพูดไหมครับ?

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
- Preserve ALL original information.
- Preserve casual chat feeling naturally.
- Preserve emotional nuance.
- Keep names, IDs, money, formulas, symbols, and numbers unchanged.
- Do not summarize.
- Do not answer the message.
- Do not add new meaning.`
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

      // ignore LINE emoji messages
      if (event.message.emojis?.length > 0) {
        continue;
      }

      const text = normalizeText(event.message.text);

      if (!text) continue;

      // ignore repetitive/system/decorative messages
      if (shouldIgnoreMessage(text)) {
        continue;
      }

      const translated = await translateText(text);

      if (!translated) continue;

      await replyToLine(event.replyToken, translated);

    } catch (err) {
      console.error(err);
    }
  }

  return res.status(200).send("OK");
}
