import { runRepaymentAfternoonCron } from "../webhook.js";

function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;

  // CRON_SECRET을 설정한 경우, Vercel Cron이 보내는 Authorization 헤더만 허용
  if (!secret) return true;

  const authHeader = req.headers.authorization || req.headers.Authorization || "";
  return authHeader === `Bearer ${secret}`;
}

function methodNotAllowed(res) {
  res.setHeader("Allow", "GET");
  return res.status(405).json({ ok: false, error: "Method Not Allowed" });
}

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res);

  if (!isAuthorized(req)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  try {
    const result = await runRepaymentAfternoonCron();

    return res.status(200).json({
      ok: true,
      job: "repayment_afternoon_18",
      result: result || "sent"
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      ok: false,
      job: "repayment_afternoon_18",
      error: err?.message || "Cron Error"
    });
  }
}
