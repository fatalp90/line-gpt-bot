import axios from "axios";

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.4";
const MAX_HISTORY_ITEMS = 8;
const MAX_HISTORY_SESSIONS = 500;

const ignoreKeywords = [
  "110551366954",
  "Important checking",
  "Check over",
    "commission",
  "Commission"
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


const thaiShortDictionary = {
  "โอนเงินมาครับ": "입금하세요",
  "โอนเงินครับ": "입금하세요",
  "โอนมาครับ": "입금하세요",
  "ชำระคืนครับ": "상환하세요",
  "ชำระครับ": "상환하세요",
  "จ่ายเงินครับ": "입금하세요",
  "ส่งสลิปครับ": "슬립 올려주세요",
  "รอสักครู่ครับ": "잠시만 기다려 주세요",
  "ครับ": "네",
  "ใช่ครับ": "맞아요",
  "ไม่ครับ": "아니요",
  "โอเคครับ": "알겠습니다",
  "ขอบคุณครับ": "감사합니다",
  "ขอโทษครับ": "죄송합니다"
};

const adminStatusKeywords = [
  "รอยอด",
  "รอ ยอด",
  "งวด",
  "งวดถัดไป",
  "ยอด",
  "ยอดวันนี้",
  "ยอดพรุ่งนี้",
  "ปิดยอด",
  "เคลียร์ยอด",
  "โอนยอด",
  "นัดยอด",
  "ชำระ",
  "จ่าย",
  "ครบ",
  "ค้าง",
  "เลื่อน",
  "ต่อยอด",
  "รียอด",
  "รี ยอด",

  // urgent / announcement style keywords
  "sos",
  "ด่วน",
  "แจ้งยอด",
  "ส่งยอด",
  "โอนเงิน",
  "ฝากเงิน",
  "ส่งสลิป",
  "สลิป",
  "เตือน",
  "ประกาศ"
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

function isMentionOnlyMessage(text) {
  const clean = normalizeText(text);
  if (!clean.startsWith("@")) return false;

  // @팀, @ยูนา, @Dex Loan, @Melalada👑 처럼 멘션만 있는 경우만 무시
  // 멘션 뒤에 실제 문장부호/문장이 붙으면 번역 대상으로 남김
  if (/[?!?.,。！？]/.test(clean)) return false;
  if (clean.length > 40) return false;

  return /^@[\p{L}\p{M}\p{N}_ .\-]+[\p{Emoji_Presentation}\p{Extended_Pictographic}]?$/u.test(clean);
}

function hasRepeatedWrapperEmoji(text) {
  const clean = normalizeText(text);

  // 짧은 날짜형 관리자 메시지에 포함된 이모지/기호 감지
  // 예:
  // 📌02/06
  // 02/06📌
  // 🔥 งวด 02/06
  // ✅✅26/05✅✅
  //
  // 일반 대화:
  // นัด31/5 ค่ะบอส
  // 20.10ได้มัยค่ะเลิกงานค่ะทำโอที
  // 는 차단하지 않음

  return /[📌✅🔥💸✔️🔔⚠️📍🚨🆘❗‼️⛔]/u.test(clean) || /sos/i.test(clean);
}

function hasDateLikePattern(text) {
  const clean = normalizeText(text).replace(/\s+/g, "");
  return /\d{1,2}[\/\-.]\d{1,2}(?:[\/\-.]\d{2,4})?/.test(clean);
}

function hasAdminStatusKeyword(text) {
  const clean = normalizeText(text).toLowerCase();
  return adminStatusKeywords.some((keyword) => clean.includes(keyword.toLowerCase()));
}

function isAdminPatternMessage(text) {
  const clean = normalizeText(text);
  if (!clean) return false;

  const shortMessage = clean.length <= 80;
  const hasNoticeEmoji = hasRepeatedWrapperEmoji(clean);
  const hasDate = hasDateLikePattern(clean);
  const hasKeyword = hasAdminStatusKeyword(clean);

  // 1) 날짜형 관리자 공지 차단
  // 예: 📌02/06, 02/06📌, ✅✅26/05✅✅
  if (shortMessage && hasNoticeEmoji && hasDate) {
    return true;
  }

  // 2) 긴급/공지형 메시지 차단
  // 예: SOS🔥ส่งยอด🔥SOS, 🚨 입금 보내주세요 🚨, 🆘 ด่วน
  // 단, 이모지/공지표시가 함께 있을 때만 차단해서 일반 대화 오차를 줄임
  if (shortMessage && hasNoticeEmoji && hasKeyword) {
    return true;
  }

  return false;
}

function shouldIgnoreMessage(text) {
  const clean = normalizeText(text);

  for (const keyword of ignoreKeywords) {
    if (clean.includes(keyword)) return true;
  }

  if (isMentionOnlyMessage(clean)) return true;
  if (isAdminPatternMessage(clean)) return true;
  if (isEnglishOnly(clean)) return true;
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

function normalizeCurrencyForThaiOutput(text) {
  return String(text || "")
    // 숫자 뒤 한국 원화 단위만 자연스럽게 태국어 วอน 으로 변환
    // 예: 600,000원 -> 600,000วอน
    .replace(/(\d[\d,]*(?:\.\d+)?)\s*원/g, "$1วอน")
    .replace(/(\d[\d,]*(?:\.\d+)?)\s*만원/g, "$1หมื่นวอน")
    .replace(/(\d[\d,]*(?:\.\d+)?)\s*천원/g, "$1พันวอน");
}

function normalizeKoreanFragmentsInThaiOutput(text) {
  return String(text || "")
    // 모델이 금액 뒤 조사/연결어를 보존 대상으로 오해해서 한국어를 남기는 경우 보정
    // 예: 195,000วอน 기준으로 -> 기준 195,000วอน
    .replace(/(\d[\d,]*(?:\.\d+)?\s*วอน)\s*기준으로/g, "โดยอิงจากยอด $1")
    .replace(/(\d[\d,]*(?:\.\d+)?\s*วอน)\s*기준/g, "โดยอิงจากยอด $1")
    .replace(/기준으로/g, "โดยอิงจาก")
    .replace(/기준/g, "เกณฑ์")
    .replace(/정상납부/g, "ชำระตามปกติ")
    .replace(/정상 납부/g, "ชำระตามปกติ")
    .replace(/입니다/g, "ครับ")
    .replace(/이에요/g, "ครับ")
    .replace(/예요/g, "ครับ");
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

async function askOpenAI({ systemPrompt, userText, history = [], convertWonToThai = false }) {
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
      max_completion_tokens: 400
    })
  });

  const data = await response.json();

  if (!response.ok) {
    console.error(data);
    throw new Error("OpenAI Error");
  }

  const translated = cleanup(data?.choices?.[0]?.message?.content || "");
  return convertWonToThai ? normalizeKoreanFragmentsInThaiOutput(normalizeCurrencyForThaiOutput(translated)) : translated;
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
- For Korean won amounts, keep the number exactly but translate the Korean unit 원 into Thai วอน. Never leave Korean 원 in Thai output.
- Example: 600,000원 -> 600,000วอน
- Do not preserve Korean connector words or particles around money amounts. Translate them naturally into Thai.
- Especially translate 기준으로 as โดยอิงจาก / 기준 as เกณฑ์ or rewrite naturally depending on context.
- Example: 195,000원을 4회 정상납부 기준으로 780,000원 입니다 -> ถ้าชำระตามปกติ 4 งวด งวดละ 195,000วอน รวมเป็น 780,000วอนครับ
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
- When Thai text contains วอน as Korean currency, translate it naturally into Korean as 원. Never leave Thai วอน in Korean output.
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

Name preservation rules:
- Thai personal names or nicknames must NEVER be translated semantically.
- Preserve Thai nicknames as pronunciation-based Korean transliteration only.
- Never reinterpret names as ordinary vocabulary or implied meaning.
- Never invent dialogue, jokes, or hidden intent from names.
- Examples:
  - อ้อย -> 어이 (nickname)
  - ยูนา -> 유나
  - นาวี -> 나비

Ambiguity rules:
- Never answer the message.
- Never reinterpret emotional implication into a different sentence meaning.
- When emotional nuance is ambiguous, stay closer to the literal meaning.

Safety/accuracy rules:
- Do not add new money, dates, times, promises, threats, or legal/police wording.
- If the Thai is genuinely ambiguous, translate in a way that keeps the ambiguity rather than guessing too much.`;


function isKoreanLaughOnly(text) {
  const clean = normalizeText(text);
  return /^[ㅋㅎ]+$/.test(clean);
}

function translateKoreanLaughToThai(text) {
  const clean = normalizeText(text);
  const length = Math.max(3, Math.min(clean.length, 12));
  return "5".repeat(length);
}

async function translateKoToTh(text, history = []) {
  if (isKoreanLaughOnly(text)) {
    return translateKoreanLaughToThai(text);
  }

  const direct = shortDictionary[text];
  if (direct) return direct;

  return await askOpenAI({
    systemPrompt: KO_TO_TH_SYSTEM_PROMPT,
    userText: text,
    history,
    convertWonToThai: true
  });
}

async function translateThToKo(text, history = []) {
  const direct = thaiShortDictionary[text];
  if (direct) return direct;

  let translated = await askOpenAI({
    systemPrompt: TH_TO_KO_SYSTEM_PROMPT,
    userText: text,
    history,
    convertWonToThai: false
  });

  // 모델이 태국어를 한국어로 번역하지 않고 태국어만 다시 출력한 경우 1회 재시도
  if (containsThai(translated) && !containsKorean(translated)) {
    translated = await askOpenAI({
      systemPrompt: TH_TO_KO_SYSTEM_PROMPT + "\nIMPORTANT: The input is Thai. You MUST output Korean only. Do NOT rewrite or paraphrase in Thai.",
      userText: text,
      history: [],
      convertWonToThai: false
    });
  }

  return translated;
}

async function translateText(text, conversationKey) {
  const history = getHistory(conversationKey);
  const hasKorean = containsKorean(text);
  const hasThai = containsThai(text);

  if (hasKorean && hasThai) {
    const koreanCount = (text.match(/[가-힣ㄱ-ㅎㅏ-ㅣ]/g) || []).length;
    const thaiCount = (text.match(/[\u0E00-\u0E7F]/g) || []).length;

    if (koreanCount >= thaiCount) {
      return await translateKoToTh(text, history);
    }

    return await translateThToKo(text, history);
  }

  if (hasKorean) {
    return await translateKoToTh(text, history);
  }

  if (hasThai) {
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

      const text = normalizeText(event.message.text);
      if (!text) continue;

      // ignore repetitive/system/decorative/admin-pattern messages
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
