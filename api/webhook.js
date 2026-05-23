import axios from "axios";

const shortDictionary = {
  "오": "โอ",
  "아": "อา",
  "어": "อืม",
  "응": "อืม",
  "네": "ครับ",
  "넵": "ครับ",
  "넹": "ครับ",
  "ㅇㅋ": "โอเคครับ",
  "오케이": "โอเคครับ",
  "알겠습니다": "รับทราบครับ",
  "좋아요": "ได้ครับ",
  "괜찮아요": "ไม่เป็นไรครับ",
  "ㅋㅋ": "555",
  "ㅎㅎ": "555",
  "ㅠㅠ": "ㅠㅠ",
  "ㅜㅜ": "ㅜㅜ"
};

function normalizeText(text) {
  return text.trim();
}

function getDictionaryTranslation(text) {
  const clean = normalizeText(text);
  return shortDictionary[clean] || null;
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

async function translateWithOpenAI(text) {
  const dictionaryResult = getDictionaryTranslation(text);
  if (dictionaryResult) return dictionaryResult;

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
          content:
            "You are a Korean-Thai translator for LINE chat. If input is Korean, translate into Thai. If input is Thai, translate into Korean. Keep the translation close to the original meaning. Do not add extra words, greetings, explanations, or interpretations. Keep short messages short. For Thai output, use polite male tone only when it naturally fits, but do not force ครับ onto single interjections like โอ, อา, อืม, 555. Output only the translated text."
        },
        {
          role: "user",
          content: text
        }
      ],
      temperature: 0
    })
  });

  const data = await response.json();

  if (!response.ok) {
    console.error("OpenAI API Error:", JSON.stringify(data));
    throw new Error(data?.error?.message || "OpenAI API request failed");
  }

  return data.choices?.[0]?.message?.content?.trim() || "번역 결과가 없습니다.";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).send("OK");
  }

  const events = req.body.events || [];

  for (const event of events) {
    try {
      if (event.type === "join") {
        await replyToLine(event.replyToken, "안녕하세요 :)");
        continue;
      }

      if (event.type !== "message") continue;
      if (event.message.type !== "text") continue;

      const text = event.message.text;
      const translated = await translateWithOpenAI(text);

      await replyToLine(event.replyToken, translated);
    } catch (error) {
      console.error("Webhook Error:", error?.message || error);

      if (event.replyToken) {
        try {
          await replyToLine(event.replyToken, "번역 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.");
        } catch (replyError) {
          console.error("LINE Reply Error:", replyError?.response?.data || replyError?.message || replyError);
        }
      }
    }
  }

  return res.status(200).send("OK");
}
