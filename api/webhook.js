import axios from "axios";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(200).send("OK");
  }

  res.status(200).send("OK");

  const events = req.body.events || [];

  for (const event of events) {

    if (event.type === "join") {
      await axios.post(
        "https://api.line.me/v2/bot/message/reply",
        {
          replyToken: event.replyToken,
          messages: [
            {
              type: "text",
              text: "안녕하세요 :)"
            }
          ]
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
            "Content-Type": "application/json"
          }
        }
      );

      continue;
    }

    if (event.type !== "message") continue;
    if (event.message.type !== "text") continue;

    const text = event.message.text;

    const completion = await openai.chat.completions.create({
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
      ]
    });

    const translated = completion.choices[0].message.content;

    await axios.post(
      "https://api.line.me/v2/bot/message/reply",
      {
        replyToken: event.replyToken,
        messages: [
          {
            type: "text",
            text: translated
          }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );
  }
}
