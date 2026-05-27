import axios from "axios";

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.5";
const MAX_HISTORY_ITEMS = 20;
const MAX_HISTORY_SESSIONS = 500;

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

const adminStatusKeywords = [
  "รอยอด",
  "รอ ยอด",
  "รอเงิน",
  "รอ เงิน",
  "รอโอน",
  "รอ โอน",
  "ยอด",
  "งวด",
  "งวดถัดไป",
  "ปิดยอด",
  "ปิด ยอด",
  "ยอดวันนี้",
  "ยอดพรุ่งนี้",
  "ยอดถัดไป",
  "รอบ",
  "คิว",
  "นัดยอด",
  "นัด ยอด"
];

const conversationStore = new Map();

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

function stripEmojiAndSymbols(text) {
  return normalizeText(text)
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0F]/gu, "")
    .replace(/[✅✔☑📌📍🔴🟢🟡🔵⭐🌟✨💰💸💵💳🧾📅📆⏰⏳⌛➡️➜➤▶️◀️🔻🔺]/gu, "")
    .replace(/[\[\]{}()<>:：,，.。!！?？|\\_*~`'"“”‘’+＝=]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function hasEmojiOrDecorativeSymbol(text) {
  return /[\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0F]/u.test(text || "") ||
    /[✅✔☑📌📍🔴🟢🟡🔵⭐🌟✨💰💸💵💳🧾📅📆⏰⏳⌛➡️➜➤▶️◀️🔻🔺]/u.test(text || "");
}

function hasDateLikePattern(text) {
  const clean = normalizeText(text);
  return /\d{1,2}[\/\-\.월]\d{1,2}(?:[\/\-\.년]\d{2,4})?/.test(clean) ||
    /\d{1,2}\s*(일|วัน|โมง|น\.|시|분)/.test(clean);
}

function isMostlyScheduleCode(text) {
  const clean = normalizeText(text);
  if (!clean) return false;

  const compact = clean.replace(/\s+/g, "");
  const stripped = stripEmojiAndSymbols(clean).replace(/\s+/g, "");

  if (hasDateLikePattern(clean) && /^[\d\/\-\.]+$/.test(stripped)) {
    return true;
  }

  if (hasDateLikePattern(clean) && /^[\u0E00-\u0E7Fa-zA-Z\d\/\-\.]+$/.test(stripped) && compact.length <= 40) {
    return true;
  }

  return false;
}

function isAdminPatternMessage(text) {
  const clean = normalizeText(text);
  if (!clean) return false;

  const hasDecor = hasEmojiOrDecorativeSymbol(clean);
  const stripped = stripEmojiAndSymbols(clean);
  const compactStripped = stripped.replace(/\s+/g, "");

  if (!hasDecor) return false;

  // 체크/핀/기타 이모지 + 날짜/회차 패턴은 번역 제외
  if (isMostlyScheduleCode(clean)) return true;

  // 이모지로 감싼 짧은 관리자 상태 메모는 번역 제외
  const hasAdminKeyword = adminStatusKeywords.some((keyword) =>
    stripped.toLowerCase().includes(keyword.toLowerCase())
  );

  if (hasAdminKeyword && stripped.length <= 45) {
    return true;
  }

  // 이모지 + 짧은 태국어/숫자 조합이며 일반 문장이라기보다 상태 라벨에 가까운 경우 제외
  const wordCount = stripped.split(/\s+/).filter(Boolean).length;
  const hasThai = containsThai(stripped);
  const hasKo = containsKorean(stripped);

  if (hasThai && !hasKo && wordCount <= 4 && stripped.length <= 35 && /ยอด|งวด|โอน|ปิด|รอ|นัด|คิว|รอบ/.test(stripped)) {
    return true;
  }

  // 이모지만 걷어냈을 때 날짜/숫자 위주이면 제외
  if (compactStripped && /^[\d\/\-\.]+$/.test(compactStripped)) {
    return true;
  }

  return false;
}


function isMentionOnlyMessage(text) {
  const clean = normalizeText(text);
  if (!clean) return false;
  if (!clean.startsWith("@")) return false;
  if (clean.includes("\n")) return false;
  if (clean.length > 40) return false;

  // 문장처럼 보이는 기호가 있으면 멘션-only로 보지 않음
  if (/[?!?.。,，:：]/.test(clean)) return false;

  const withoutAt = clean.slice(1).trim();
  if (!withoutAt) return false;

  const parts = withoutAt.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return true;

  // @Dex Loan 처럼 영어 표시명에 띄어쓰기가 있는 경우는 멘션-only로 처리
  // 단, @유나 입금확인 / @ทีม ลูกค้า... 처럼 한국어·태국어 실제 문장이 붙은 경우는 번역 대상으로 둠
  const restAfterFirst = parts.slice(1).join(" ");
  if (/[가-힣ㄱ-ㅎㅏ-ㅣ\u0E00-\u0E7F]/.test(restAfterFirst)) return false;

  return parts.length <= 3;
}

function shouldIgnoreMessage(text) {
  const clean = normalizeText(text);

  for (const keyword of ignoreKeywords) {
    if (clean.includes(keyword)) return true;
  }

  // 멘션만 단독으로 있는 메시지는 번역하지 않음
  // 예: @팀, @ยูนา, @Dex Loan
  if (isMentionOnlyMessage(clean)) return true;

  // 관리자들이 체크, 핀 등 다양한 이모지로 표시하는 상환/일정/상태 패턴 메시지는 번역하지 않음
  if (isAdminPatternMessage(clean)) return true;

  // 영어만 있는 메시지는 무시
  // 예: SUMALEE JUTTANO, @Dex Loan
  // 단, @Dex Loan บอสช้า 처럼 태국어/한국어가 함께 있으면 번역함
  if (isEnglishOnly(clean)) return true;

  // 장식/이모지만 있는 메시지는 무시
  if (isDecorationOnly(clean)) return true;

  return false;
}

function cleanup(text) {
  return String(text || "")
    .replace(/^(\s*\.\.\.\s*)+/g, "")
    .replace(/^(\s*…\s*)+/g, "")
    .replace(/^번역[:：]\s*/i, "")
    .replace(/^Translation[:：]\s*/i, "")
    .trim();
}

function getConversationKey(event) {
  const source = event?.source || {};
  return source.groupId || source.roomId || source.userId || "default";
}

function getHistory(conversationKey) {
  return conversationStore.get(conversationKey) || [];
}

function saveHistory(conversationKey, sourceText, translatedText) {
  if (!conversationKey || !sourceText || !translatedText) return;

  const history = getHistory(conversationKey);
  history.push({
    source: sourceText,
    translated: translatedText,
    at: Date.now()
  });

  conversationStore.set(conversationKey, history.slice(-MAX_HISTORY_ITEMS));

  if (conversationStore.size > MAX_HISTORY_SESSIONS) {
    const oldestKey = conversationStore.keys().next().value;
    if (oldestKey) conversationStore.delete(oldestKey);
  }
}

function buildContextText(history) {
  if (!history?.length) return "";

  return history
    .slice(-MAX_HISTORY_ITEMS)
    .map((item, index) => `${index + 1}. 원문: ${item.source}\n   번역: ${item.translated}`)
    .join("\n");
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

async function askOpenAI({ systemPrompt, userText, history = [] }) {
  const contextText = buildContextText(history);

  const messages = [
    {
      role: "system",
      content: systemPrompt
    }
  ];

  if (contextText) {
    messages.push({
      role: "user",
      content: `최근 대화 맥락입니다. 이 내용은 참고만 하고, 아래의 새 메시지만 번역하세요.\n\n${contextText}`
    });
  }

  messages.push({
    role: "user",
    content: `새 메시지:\n${userText}`
  });

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages,
      max_completion_tokens: 1500
    })
  });

  const data = await response.json();

  if (!response.ok) {
    console.error(data);
    throw new Error("OpenAI Error");
  }

  return cleanup(data?.choices?.[0]?.message?.content || "");
}

const KO_TO_TH_SYSTEM_PROMPT = `You are a Korean to Thai LINE chat interpreter.

Your goal is NOT literal word-by-word translation.
Your goal is to preserve:
- original meaning
- emotional nuance
- implied Korean conversational intent
- relationship tone
- natural Thai LINE chat style

Core rules:
- Translate Korean into natural Thai only.
- Output Thai only. Do not add explanations.
- Preserve all names, IDs, amounts, dates, numbers, symbols, formulas, and structured categories.
- Never omit important information.
- Never summarize.
- Never invent context that is not written or strongly implied.
- Never add new money, dates, times, promises, threats, or legal/police wording.
- Use the recent context only to understand tone and implied meaning, not to add new facts.

Male speech rules:
- The speaker is male by default.
- Use polite male Thai naturally.
- Use ครับ when natural.
- Never use female particles: ค่ะ, คะ, จ้า, จ๊ะ, ค่า, นะคะ, นะค่ะ.

Natural Thai rules:
- Make it sound like a real Thai person chatting on LINE.
- Keep short messages short.
- Preserve teasing, soft joking, worry, frustration, apology, firmness, and affection naturally.
- Understand Korean casual expressions like ㅋㅋ, ㅎㅎ, ㅠㅠ, TT, 아/오/어/응/네.
- ㅋㅋ or ㅎㅎ may become 555 only when natural. Do not force it.
- Avoid robotic dictionary-style Thai.

Time rule:
- Do not add วันนี้, เมื่อคืน, ตอนนี้, พรุ่งนี้, or other time words unless they exist in Korean or are absolutely required by grammar.

Meaning preservation examples:
신규+기존 총 19명입니다 :)
-> ลูกค้าใหม่+ลูกค้าเก่า รวมทั้งหมด 19 คนครับ :)
Do not reduce this to only รวมทั้งหมด 19 คนครับ :)

Good examples:
편하죠?ㅋㅋ
-> สบายใช่ไหมครับ 555

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
-> ขอโทษครับ 555`;

const TH_TO_KO_SYSTEM_PROMPT = `You are a Thai to Korean LINE chat interpreter.

Your goal is NOT literal word-by-word translation.
Your goal is to preserve:
- original meaning
- emotional nuance
- implied Thai conversational intent
- relationship tone
- natural Korean chat style

Core rules:
- Translate Thai into natural Korean only.
- Output Korean only. Do not add explanations.
- Preserve all names, IDs, amounts, dates, numbers, symbols, formulas, and structured categories.
- Never omit important information.
- Never summarize.
- Never answer the message.
- Never invent context that is not written or strongly implied.
- Use the recent context only to understand tone and implied meaning, not to add new facts.

Thai understanding rules:
- Thai LINE messages often contain typos, slang, missing spaces, repeated letters, particles, or informal wording.
- If there is an obvious typo, infer the most natural meaning from context.
- Preserve casual, cute, teasing, annoyed, worried, apologetic, or firm tone naturally in Korean.
- Translate particles like ค่ะ/คะ/ครับ according to the speaker's tone, not mechanically.
- Keep short messages short.

Safety/accuracy rules:
- Do not add new money, dates, times, promises, threats, or legal/police wording.
- If the Thai is genuinely ambiguous, translate in a way that keeps the ambiguity rather than guessing too much.`;

async function translateKoToTh(text, history = []) {
  const direct = shortDictionary[text];
  if (direct) return direct;

  return await askOpenAI({
    systemPrompt: KO_TO_TH_SYSTEM_PROMPT,
    userText: text,
    history
  });
}

async function translateThToKo(text, history = []) {
  return await askOpenAI({
    systemPrompt: TH_TO_KO_SYSTEM_PROMPT,
    userText: text,
    history
  });
}

async function translateText(text, conversationKey) {
  const history = getHistory(conversationKey);

  const hasKo = containsKorean(text);
  const hasTh = containsThai(text);

  if (hasKo && !hasTh) {
    return await translateKoToTh(text, history);
  }

  if (hasTh && !hasKo) {
    return await translateThToKo(text, history);
  }

  if (hasKo && hasTh) {
    const koreanCount = (text.match(/[가-힣ㄱ-ㅎㅏ-ㅣ]/g) || []).length;
    const thaiCount = (text.match(/[\u0E00-\u0E7F]/g) || []).length;

    if (koreanCount >= thaiCount) {
      return await translateKoToTh(text, history);
    }

    return await translateThToKo(text, history);
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

      // ignore repetitive/system/decorative/admin schedule messages
      if (shouldIgnoreMessage(text)) {
        continue;
      }

      const conversationKey = getConversationKey(event);
      const translated = await translateText(text, conversationKey);
      if (!translated) continue;

      saveHistory(conversationKey, text, translated);
      await replyToLine(event.replyToken, translated);

    } catch (err) {
      console.error(err);
    }
  }

  return res.status(200).send("OK");
}
