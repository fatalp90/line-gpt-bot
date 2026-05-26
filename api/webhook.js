import axios from "axios";

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.5";
const MAX_HISTORY_ITEMS = 10;
const MAX_HISTORY_SESSIONS = 300;

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

function shouldIgnoreMessage(text) {
  const clean = normalizeText(text);

  for (const keyword of ignoreKeywords) {
    if (clean.includes(keyword)) return true;
  }

  // 영어만 있는 메시지는 무시
  // 예: SUMALEE JUTTANO, @Dex Loan
  // 단, @Dex Loan บอสช้า 처럼 태국어/한국어가 함께 있으면 번역함
  if (isEnglishOnly(clean)) return true;

  // 장식/이모지만 있는 메시지는 무시
  if (isDecorationOnly(clean)) return true;

  return false;
}

function cleanup(text, options = {}) {
  let output = String(text || "")
    .replace(/^(\s*\.\.\.\s*)+/g, "")
    .replace(/^(\s*…\s*)+/g, "")
    .replace(/^번역[:：]\s*/i, "")
    .replace(/^Translation[:：]\s*/i, "")
    .trim();

  // Korean -> Thai output must not contain accidental Chinese/Japanese characters.
  // Example problem: 正直ตอนนี้... -> ตอนนี้...
  if (options.targetThai) {
    output = output.replace(/[\u3400-\u9FFF\u3040-\u30FF]/g, "").trim();
  }

  return output;
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

async function askOpenAI({ systemPrompt, userText, history = [], targetThai = false }) {
  const contextText = buildContextText(history);

  const input = [];

  if (contextText) {
    input.push({
      role: "user",
      content: `최근 대화 맥락입니다. 이 내용은 참고만 하고, 아래의 새 메시지만 번역하세요.\n\n${contextText}`
    });
  }

  input.push({
    role: "user",
    content: `새 메시지:\n${userText}`
  });

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      instructions: systemPrompt,
      input,
      max_output_tokens: 700,
      reasoning: { effort: "low" },
      text: { verbosity: "low" }
    })
  });

  const data = await response.json();

  if (!response.ok) {
    console.error("OpenAI Error:", JSON.stringify(data, null, 2));
    throw new Error("OpenAI Error");
  }

  const outputText =
    data?.output_text ||
    data?.output?.flatMap(item => item?.content || [])
      ?.map(content => content?.text || "")
      ?.join("") ||
    "";

  return cleanup(outputText, { targetThai });
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
- NEVER mix Chinese, Japanese, Korean, or other languages into Thai output. Thai output must contain Thai language only, except original names, IDs, brand names, English terms, numbers, and symbols.
- Preserve all names, IDs, amounts, dates, numbers, symbols, formulas, and structured categories.
- Never omit important information.
- Never summarize.
- Never invent context that is not written or strongly implied.
- Never add new money, dates, times, promises, threats, or legal/police wording.
- Use the recent context only to understand tone and implied meaning, not to add new facts.

Relationship / tone mode rules:
Before translating, silently infer who the message is for from the current message and recent context.

1) Customer-facing mode:
Use this when the Korean message is directed to a borrower/customer or asks for payment, repayment, documents, passport, QR, video call, address, workplace, deadline, confirmation, or cooperation.
Tone: polite male Thai, firm when needed, clear and businesslike. Do not sound like joking with an admin. Avoid overly cute or casual wording.

2) Admin/internal mode:
Use this when talking to an admin, boss, manager, assistant, or teammate about customers, groups, checks, approvals, commissions, documents, status, or internal handling.
Tone: cooperative, natural, colleague-like, softer and more explanatory.

3) Casual/personal mode:
Use this for friendly personal chat, jokes, comfort, teasing, thanks, apology, or light conversation.
Tone: warm, natural LINE chat style.

If uncertain, choose the safest polite male Thai tone without adding assumptions.

Male speech rules:
- The speaker is male by default.
- Use polite male Thai naturally.
- Use ครับ when natural.
- Never use female particles: ค่ะ, คะ, จ้า, จ๊ะ, ค่า, นะคะ, นะค่ะ.

Natural Thai rules:
- Make it sound like a real Thai person chatting on LINE.
- Keep short messages short.
- Preserve teasing, soft joking, worry, frustration, apology, firmness, and affection naturally.
- In customer-facing warning/payment messages, be firm but not childish.
- For 짜증나게 하지마라 / 장난하세요 / 뭐하는 겁니까, translate the pressure naturally, not as literal dictionary Thai.
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

입금하세요. 빨리 ㅡㅡ 장난하세요?
-> โอนเงินมาครับ เร็วๆหน่อย นี่ล้อเล่นอยู่หรือเปล่าครับ?

짜증나게 하지마라?? 빨리 입금
-> อย่าทำให้เรื่องมันปวดหัวเลยครับ รีบโอนเงินมาครับ

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

Relationship / tone mode rules:
Silently infer whether the Thai message is from/to a customer, admin/internal teammate, or casual personal chat.
- Customer message: translate into Korean with the feeling of a borrower/customer explaining, delaying, apologizing, resisting, or confirming.
- Admin/internal message: translate with colleague/admin tone about customers, groups, approvals, commissions, checks, documents, or handling.
- Casual/personal message: translate warmly and naturally.
Do not flatten every message into the same tone.

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
    history,
    targetThai: true
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

  if (containsKorean(text)) {
    return await translateKoToTh(text, history);
  }

  if (containsThai(text)) {
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

      // ignore repetitive/system/decorative messages
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
