import OpenAI from "openai";
import axios from "axios";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req, res) {
  try {
    const event = req.body.events?.[0];

    if (!event || event.type !== "message") {
      return res.status(200).json({ ok: true });
    }

    const userMessage = event.message.text;

    const prompt = `
You are a professional Korean-Thai translator.

Rules:
- If input is Korean, translate to natural Thai.
- If input is Thai, translate to natural Korean.
- ALWAYS use Thai male speech style.
- ALWAYS use ครับ instead of ค่ะ.
- NEVER use female particles.
- Keep casual chat natural and short.
- Convert Korean laughter like ㅋㅋ, ㅎㅎ into 555.
- Do not explain.
- Output translation only.
`;

    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content: prompt,
        },
        {
          role: "user",
          content: userMessage,
        },
      ],
      temperature: 0.3,
    });

    const translated =
      completion.choices[0].message.content.trim();

    await axios.post(
      "https://api.line.me/v2/bot/message/reply",
      {
        replyToken: event.replyToken,
        messages: [
          {
            type: "text",
            text: translated,
          },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: error.message,
    });
  }
}
