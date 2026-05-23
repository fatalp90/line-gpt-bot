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
한국어를 태국어로 직역해줘.

규칙:
- 원문 느낌 유지
- 의역 최소화
- 짧게 번역
- 태국 남자 LINE 채팅 말투 사용
- 여성 말투 사용 금지
- ㅋㅋ,ㅎㅎ → 555
- 브랜드명/영어 유지
- 결과만 출력
`, text);
  }

  if (lang === "th") {
    return await askOpenAI(`
태국어를 한국어로 직역해줘.

규칙:
- 원문 느낌 유지
- 의역 최소화
- 짧게 번역
- 결과만 출력
`, text);
  }

  if (lang === "en") {
    const korean = await askOpenAI(`
영어를 한국어로 직역해줘.
결과만 출력해줘.
`, text);

    const thai = await askOpenAI(`
영어를 태국 남자 LINE 채팅 말투로 직역해줘.
여성 말투 사용 금지.
결과만 출력해줘.
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
        await replyToLine(event.replyToken, "번역 봇 연결 완료");
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
            "번역 오류"
          );
        }
      } catch (replyError) {
        console.error("LINE Reply Error:", replyError?.response?.data || replyError?.message || replyError);
      }
    }
  }

  return res.status(200).send("OK");
}
