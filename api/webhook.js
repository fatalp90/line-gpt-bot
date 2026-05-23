import axios from "axios";

const shortDictionary = {
  "오": "โอ",
  "아": "อา",
  "어": "อืม",
  "응": "อืม",
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

function cleanupTranslationOutput(text) {
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
      messages,
      temperature: 0
    })
  });

  const data = await response.json();

  if (!response.ok) {
    console.error("OpenAI Error:", JSON.stringify(data));
    throw new Error(data?.error?.message || "OpenAI request failed");
  }

  return data?.choices?.[0]?.message?.content?.trim() || "";
}

async function translateKoreanToThai(text) {
  const dictionaryResult = getDictionaryTranslation(text);
  if (dictionaryResult) return dictionaryResult;

  const result = await askOpenAI([
    {
      role: "system",
      content: `You are a Korean to Thai translator for LINE chat.

Output:
- Return ONLY valid JSON.
- Use Thai male speech style.
- Use ครับ when needed.
- NEVER use female Thai particles such as ค่ะ, คะ, จ๊ะ, จ้า, ค่า, นะคะ, นะค่ะ.
- Preserve the speaker's original Korean tone and sentence style as closely as possible.

Important translation rules:
- Preserve questioning tone naturally.
- Preserve conversational pressure and nuance.
- Preserve rhetorical expressions.
- Preserve sentence rhythm and emotional flow.
- Keep wording as close as possible to the original Korean meaning.
- Write like a real Korean speaker talking in Thai.
- Very short Korean replies should stay short and natural in Thai.
- Do NOT overly summarize.
- Do NOT overly localize.
- Do NOT flatten questions into neutral statements.
- Do NOT change emotional intent.
- Do NOT add new information.
- Do NOT add laughter such as 555 unless the Korean source actually contains ㅋㅋ or ㅎㅎ.
- Keep punctuation and sentence endings as close as possible to the Korean source.
- Preserve English brand/app names such as LINE, Facebook, Instagram, Google, Boss.

Examples:
네 -> ครับ
응 -> อืมครับ
아니요 -> ไม่ครับ
맞아요 -> ใช่ครับ
네 맞습니다 -> ใช่ครับ
급여일 15일 아니었어요? -> วันเงินเดือนวันที่ 15 ไม่ใช่เหรอครับ?
그냥 정상적으로 좀 갚으면 안될까요? -> ชำระคืนตามปกติหน่อยไม่ได้เหรอครับ?
지금 뭐하시는거죠? -> ตอนนี้กำลังทำอะไรอยู่ครับ?
고객이 진행안한다고 하던가요? -> ลูกค้าบอกว่าไม่ดำเนินการใช่ไหมครับ?
할말있나요? -> มีอะไรจะพูดไหมครับ?
이정도면 됐다ㅎㅎ -> แค่นี้ก็พอแล้ว 555`
    },
    {
      role: "user",
      content: `Translate this Korean source text into Thai while preserving the original Korean tone, sentence structure, questioning nuance, and conversational feeling as closely as possible.

Return ONLY JSON:
{"normal":"..."}

SOURCE:
${text}`
    }
  ]);

  try {
    const parsed = JSON.parse(result);
    return cleanupTranslationOutput(parsed.normal || "");
  } catch {
    return cleanupTranslationOutput(result);
  }
}

async function translateThaiOrEnglishToKorean(text) {
  const result = await askOpenAI([
    {
      role: "system",
      content: `You are a professional Thai/English to Korean translator.

Output language:
- Korean only.

Tasks:
- Thai to Korean.
- English to Korean.
- Mixed Thai + English to Korean.

Keep unchanged:
- @mentions / tags / IDs.
- Numbers, money amounts, formulas, dates, and times.
- English brand/app names if translating them would be awkward.

Rules:
- Do not answer the message.
- Do not react to the message.
- Do not explain the message.
- Do not say sorry.
- Do not say you cannot do it.
- Only translate the source text into Korean.
- Translate every Thai word, even when attached to numbers or formulas.
- Preserve line order for multiple lines.
- If grammar is messy or chat-style, translate the closest natural Korean meaning.
- Preserve awkward or casual chat tone if present.

Examples:
วันนี้มีส่งยอดนะคะ -> 오늘 입금 있습니다.
กรุณารักษาเวลา และชำระเงินก่อนเวลา 20.00 น -> 시간을 지켜주시고 20:00 이전에 입금해주세요.
ลงข้างบน60000*15 -> 위에 60,000 x 15로 올려요.
@Dex Loan 500,000=60,000x15day ka (No cut ka) -> @Dex 대출 500,000 = 60,000 x 15일입니다 (수수료 없음).`
    },
    {
      role: "user",
      content: `Translate the following source text into Korean only. Do not respond to it.

${text}`
    }
  ]);

  return cleanupTranslationOutput(result);
}

async function translateEnglishToBoth(text) {
  const korean = await translateThaiOrEnglishToKorean(text);

  const thaiResult = await askOpenAI([
    {
      role: "system",
      content: `You are an English to Thai translator for LINE chat.

Rules:
- Translate English into Thai.
- Use Thai male speech style.
- Use ครับ when needed.
- NEVER use female Thai particles such as ค่ะ, คะ, จ๊ะ, จ้า, ค่า, นะคะ, นะค่ะ.
- Keep the original meaning and tone.
- Do not add laughter or extra emotion.
- Preserve brand/app names.
- Output only Thai translation.`
    },
    {
      role: "user",
      content: text
    }
  ]);

  return `KR: ${cleanupTranslationOutput(korean)}\nTH: ${cleanupTranslationOutput(thaiResult)}`;
}

async function translateText(text) {
  const lang = detectLanguage(text);

  if (lang === "ko") return await translateKoreanToThai(text);
  if (lang === "th") return await translateThaiOrEnglishToKorean(text);
  if (lang === "en") return await translateEnglishToBoth(text);

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

      const text = normalizeText(event.message.text);
      if (!text) continue;

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
