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

const femaleReplaceMap = {
  "ค่ะ": "ครับ",
  "คะ": "ครับ",
  "นะคะ": "",
  "นะค่ะ": "",
  "จ้า": "",
  "จ๊ะ": "",
  "ล่ะ": "",
  "อ่ะ": "",
  "อะ": "",
  "ค่า": ""
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

function forceMaleThai(text) {
  let result = text;

  for (const [female, male] of Object.entries(femaleReplaceMap)) {
    result = result.split(female).join(male);
  }

  result = result.replace(/\s+/g, " ").trim();

  return result;
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
      temperature: 0.1,
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
    let thai = await askOpenAI(`
태국 남자 LINE 채팅 말투로 자연스럽게 번역해줘.

규칙:
- 여성 말투 사용 금지
- 짧고 자연스럽게
- 실제 태국 LINE 느낌으로
- ㅋㅋ,ㅎㅎ → 555
- 영어 브랜드명 유지
- 결과만 출력
`, text);

    return forceMaleThai(thai);
  }

  if (lang === "th") {
    return await askOpenAI(`
태국어를 자연스러운 한국어 채팅 말투로 번역해줘.
짧고 자연스럽게 번역해줘.
결과만 출력해줘.
`, text);
  }

  if (lang === "en") {
    const korean = await askOpenAI(`
영어를 자연스러운 한국어 채팅 말투로 번역해줘.
결과만 출력해줘.
`, text);

    let thai = await askOpenAI(`
영어를 자연스러운 태국 남자 LINE 채팅 말투로 번역해줘.
여성 말투는 사용하지마.
결과만 출력해줘.
`, text);

    thai = forceMaleThai(thai);

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
