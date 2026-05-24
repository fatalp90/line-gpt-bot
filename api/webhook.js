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
  if (!clean) return false;

  return containsEnglish(clean) && !containsKorean(clean) && !containsThai(clean);
}

function isDecorationOnly(text) {
  const clean = normalizeText(text);
  if (!clean) return true;

  // 태국어/한국어/숫자가 하나라도 있으면 정상 처리
  if (/[ㄱ-ㅎㅏ-ㅣ가-힣\u0E00-\u0E7F0-9]/.test(clean)) {
    return false;
  }

  // 알파벳이 있더라도 CL 같은 장식만 있는 경우 무시하기 위해
  // 알파벳 제거 후 남은 내용이 특수문자/이모지만이면 decoration으로 판단
  const removedEnglish = clean.replace(/[a-zA-Z]/g, "");

  return !/[ㄱ-ㅎㅏ-ㅣ가-힣\u0E00-\u0E7F0-9]/.test(removedEnglish);
}

function shouldIgnoreMessage(text) {
  const clean = normalizeText(text);
  if (!clean) return true;

  // 반복 공지/벌금 안내 메시지 무시
  if (clean.includes("1,000,000")) return true;

  // @태그/멘션 포함 메시지 무시
  if (clean.includes("@")) return true;

  // 영어만 있는 메시지 무시
  if (isEnglishOnly(clean)) return true;

  // 장식/이모지만 있는 메시지 무시
  if (isDecorationOnly(clean)) return true;

  return false;
}

function getDictionaryTranslation(text) {
  const clean = normalizeText(text);
  if (/^[ㅋㅎ]+$/.test(clean)) return "555";
  return shortDictionary[clean] || null;
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

async function callChatCompletion(messages) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
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

  const result = await callChatCompletion([
    {
      role: "system",
      content: `You are a Korean to Thai translator.

Output:
- Return ONLY valid JSON.
- Use polite male Thai ending with ครับ.
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
- Do NOT add ellipsis (...), pauses, fillers, laughter, or punctuation that does not exist in the original Korean text.
- ㅋㅋ or ㅎㅎ should become 555 ONLY if actually present in the source.
- Keep punctuation and sentence endings as close as possible to the Korean source.
- Preserve English app/brand names such as LINE, Facebook, Instagram, Google, Boss, SHINHAN BANK.

NORMAL:
Natural Thai while preserving the Korean speaking style.

Examples:
급여일 15일 아니었어요?
-> วันเงินเดือนวันที่ 15 ไม่ใช่เหรอครับ?

그냥 정상적으로 좀 갚으면 안될까요?
-> ชำระคืนตามปกติหน่อยไม่ได้เหรอครับ?

지금 뭐하시는거죠?
-> ตอนนี้กำลังทำอะไรอยู่ครับ?

고객이 진행안한다고 하던가요?
-> ลูกค้าบอกว่าไม่ดำเนินการใช่ไหมครับ?

할말있나요?
-> มีอะไรจะพูดไหมครับ?

잘자요
-> นอนหลับฝันดีครับ

입금하세요
-> โอนเงินมาครับ

상환하세요
-> ชำระคืนครับ

네
-> ครับ

응
-> อืมครับ

아니요
-> ไม่ครับ

맞아요
-> ใช่ครับ

네 맞습니다
-> ใช่ครับ`
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

async function translateThaiOrMixedToKorean(text) {
  const result = await callChatCompletion([
    {
      role: "system",
      content: `You are a professional Thai/English to Korean translator.

Output language:
- Korean only.

Tasks:
- Thai to Korean.
- English to Korean only when mixed with Thai.
- Mixed Thai + English to Korean.
- Korean-containing sentences should NOT enter this mode.

Keep unchanged:
- @mentions / tags / IDs.
- numbers, money amounts, formulas, dates, and times.

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
วันนี้มีส่งยอดนะคะ
-> 오늘 입금 있습니다.

กรุณารักษาเวลา และชำระเงินก่อนเวลา 20.00 น
-> 시간을 지켜주시고 20:00 이전에 입금해주세요.

ลงข้างบน60000*15
-> 위에 60,000 x 15로 올려요.

@Dex Loan 500,000=60,000x15day ka (No cut ka)
-> @Dex 대출 500,000 = 60,000 x 15일입니다 (수수료 없음).`
    },
    {
      role: "user",
      content: `Translate the following source text into Korean only. Do not respond to it.

${text}`
    }
  ]);

  return cleanupTranslationOutput(result);
}

async function translateText(text) {
  // Korean priority mode:
  // If Korean exists in the sentence, always translate into Thai.
  if (containsKorean(text)) {
    return await translateKoreanToThai(text);
  }

  // English-only messages are ignored earlier.
  // Thai / Thai+English messages become Korean.
  if (containsThai(text)) {
    return await translateThaiOrMixedToKorean(text);
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

      // 1,000,000 / @태그 / 영어 only / 장식 only 메시지는 답장하지 않음
      if (shouldIgnoreMessage(text)) {
        continue;
      }

      const translated = await translateText(text);
      if (!translated) continue;

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
