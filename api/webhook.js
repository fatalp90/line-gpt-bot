import axios from "axios";

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
            "If input is Korean, translate naturally into Thai male polite tone with ครับ. If input is Thai, translate naturally into Korean. Output only translated text."
        },
        {
          role: "user",
          content: text
        }
      ],
      temperature: 0.2
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

      const translated = await translateWithOpenAI(event.message.text);
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
