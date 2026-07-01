import axios from "axios";
import crypto from "crypto";

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.4";
const MAX_HISTORY_ITEMS = 8;
const MAX_HISTORY_SESSIONS = 500;


const SHEET_ID = process.env.GOOGLE_SHEET_ID || "";
const SHEET_NAME = process.env.GOOGLE_SHEET_NAME || "2026(통합)";
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "";
const GOOGLE_PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
const GOOGLE_SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const DATE_START_COLUMN_INDEX = 11; // L column, 0-based
const DATE_END_COLUMN_INDEX = 41; // AP column, 0-based
const CLOSED_BACKGROUND_RGB = { red: 0.8, green: 0.8, blue: 0.8 }; // #CCCCCC
const CLOSED_TEXT_RGB = { red: 1, green: 0, blue: 0 }; // #FF0000
const GROUP_MAP_SHEET_NAME = process.env.LINE_GROUP_MAP_SHEET_NAME || "LINE그룹매핑";
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || "")
  .split(",")
  .map(v => v.trim())
  .filter(Boolean);

const RECEIPT_OCR_MODEL = process.env.RECEIPT_OCR_MODEL || process.env.OPENAI_VISION_MODEL || "gpt-4.1-mini";
const RECEIPT_MIN_CONFIDENCE = Number(process.env.RECEIPT_MIN_CONFIDENCE || 0.50);
const RECEIPT_MIN_RECEIPT_SCORE = Number(process.env.RECEIPT_MIN_RECEIPT_SCORE || 70);
const RECEIPT_EXPECTED_SENDER_NAME = process.env.RECEIPT_EXPECTED_SENDER_NAME || "CHAYAPONE";
const RECEIPT_EXPECTED_ACCOUNT_NUMBER = process.env.RECEIPT_EXPECTED_ACCOUNT_NUMBER || "110551366954";
// true면 입금자명/받는분명/예금주명이 기대값과 다를 때 이체 캡처여도 조용히 무시한다.
const RECEIPT_REQUIRE_EXPECTED_SENDER = String(process.env.RECEIPT_REQUIRE_EXPECTED_SENDER || "true").toLowerCase() !== "false";
const RECEIPT_APPROVER_USER_IDS = (process.env.RECEIPT_APPROVER_USER_IDS || "")
  .split(",")
  .map(v => v.trim())
  .filter(Boolean);
const CHECKOVER_ADMIN_USER_IDS = (process.env.CHECKOVER_ADMIN_USER_IDS || "")
  .split(",")
  .map(v => v.trim())
  .filter(Boolean);

// 고객방에 뜨는 이체사진 등록 버튼을 관리자 확인방에도 함께 보내는 기능.
// 기본은 LINE그룹매핑 시트에서 PP01 코드로 등록된 그룹방을 관리자 확인방으로 사용한다.
// 필요 시 RECEIPT_APPROVAL_GROUP_ID에 그룹ID를 직접 넣거나, RECEIPT_APPROVAL_GROUP_CODE를 다른 코드로 바꿀 수 있다.
const RECEIPT_APPROVAL_GROUP_CODE = String(process.env.RECEIPT_APPROVAL_GROUP_CODE || "PP01").trim().toUpperCase();
const RECEIPT_APPROVAL_GROUP_ID = String(process.env.RECEIPT_APPROVAL_GROUP_ID || "").trim();
const RECEIPT_PENDING_SHEET_NAME = process.env.RECEIPT_PENDING_SHEET_NAME || "LINE등록대기";

const RECEIPT_DUPLICATE_TTL_MS = Number(process.env.RECEIPT_DUPLICATE_TTL_MS || 24 * 60 * 60 * 1000);
// 고객이 같은 송금내역을 위/아래 화면으로 나눠 2장 이상 연속 전송하는 경우
// 등록 버튼이 여러 개 뜨지 않도록 짧은 시간 동안 같은 그룹/코드/금액은 하나만 허용한다.
const RECEIPT_NEAR_DUPLICATE_TTL_MS = Number(process.env.RECEIPT_NEAR_DUPLICATE_TTL_MS || 5 * 60 * 1000);
const receiptDuplicateCache = globalThis.__receiptDuplicateCache || new Map();
globalThis.__receiptDuplicateCache = receiptDuplicateCache;

function cleanupReceiptDuplicateCache(now = Date.now()) {
  for (const [key, item] of receiptDuplicateCache.entries()) {
    const expiresAt = Number(item?.expiresAt || 0);
    if (expiresAt <= now) receiptDuplicateCache.delete(key);
  }
}

function receiptCacheSet(key, patch = {}, ttlMs = RECEIPT_DUPLICATE_TTL_MS) {
  if (!key) return null;
  const now = Date.now();
  cleanupReceiptDuplicateCache(now);
  const prev = receiptDuplicateCache.get(key) || {};
  const next = { ...prev, ...patch, updatedAt: now, expiresAt: now + ttlMs };
  receiptDuplicateCache.set(key, next);
  return next;
}

function receiptCacheGet(key) {
  if (!key) return null;
  cleanupReceiptDuplicateCache(Date.now());
  return receiptDuplicateCache.get(key) || null;
}


// LINE webhook retry / duplicate guard
// 같은 날 같은 명령어를 여러 번 직접 보내는 것은 허용한다.
// 단, LINE이 같은 message.id를 재전송하거나 서버가 같은 요청을 중복 처리하는 경우만 짧게 차단한다.
const PROCESSED_MESSAGE_TTL_MS = Number(process.env.PROCESSED_MESSAGE_TTL_MS || 10 * 60 * 1000);
const processedMessageCache = globalThis.__lineProcessedMessageCache || new Map();
globalThis.__lineProcessedMessageCache = processedMessageCache;

function cleanupProcessedMessageCache(now = Date.now()) {
  for (const [key, expiresAt] of processedMessageCache.entries()) {
    if (expiresAt <= now) {
      processedMessageCache.delete(key);
    }
  }
}

function getEventDedupKey(event) {
  const messageId = event?.message?.id;
  if (!messageId) return null;

  const sourceType = event?.source?.type || "unknown";
  const sourceId = event?.source?.groupId || event?.source?.roomId || event?.source?.userId || "unknown";
  return `${sourceType}:${sourceId}:${messageId}`;
}

function markMessageProcessing(event) {
  const key = getEventDedupKey(event);
  if (!key) return true;

  const now = Date.now();
  cleanupProcessedMessageCache(now);

  if (processedMessageCache.has(key)) {
    return false;
  }

  processedMessageCache.set(key, now + PROCESSED_MESSAGE_TTL_MS);
  return true;
}

const LINE_CUSTOMER_START_ROW = 1058;
const LINE_CUSTOMER_START_INDEX0 = LINE_CUSTOMER_START_ROW - 1;
const LINE_BROADCAST_START_DATE = process.env.LINE_BROADCAST_START_DATE || "2026-04-01";
const REPAYMENT_IGNORE_NOTICE = "(หากชำระเรียบร้อยแล้ว สามารถละเว้นข้อความนี้ได้ครับ)";

const REPAYMENT_MORNING_MESSAGE = `📌 วันนี้เป็นวันชำระ
โอนภายในเวลา 20:00 น.

👉ธนาคาร SHINHAN BANK
👉ชื่อบช. 110551366954
👉ชื่อ  CHAYAPONE

${REPAYMENT_IGNORE_NOTICE}`;

const REPAYMENT_AFTERNOON_MESSAGE = `📌 เวลา 20:00 น. แล้ว
รีบโอนเงินด้วยครับ

👉ธนาคาร SHINHAN BANK
👉ชื่อบช. 110551366954
👉ชื่อ  CHAYAPONE

${REPAYMENT_IGNORE_NOTICE}`;

const PAYMENT_REQUEST_MESSAGE = `📌 ยังไม่พบยอดโอน
รีบโอนเงินครับ

👉ธนาคาร SHINHAN BANK
👉ชื่อบช. 110551366954
👉ชื่อ  CHAYAPONE

${REPAYMENT_IGNORE_NOTICE}`;


function base64Url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function columnNumberToLetter(columnNumber) {
  let temp = "";
  let n = columnNumber;
  while (n > 0) {
    const rem = (n - 1) % 26;
    temp = String.fromCharCode(65 + rem) + temp;
    n = Math.floor((n - rem - 1) / 26);
  }
  return temp;
}

function escapeSheetName(name) {
  return String(name).replace(/'/g, "''");
}

function getKoreaToday() {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });

  const [year, month, day] = formatter.format(new Date()).split("-").map(Number);
  return { year, month, day };
}

function getKoreaDateTimeText(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);

  const get = type => parts.find(part => part.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

function parseSheetCommand(text) {
  const clean = normalizeText(text).replace(/\s+/g, "");
  const match = clean.match(/^([A-Za-z]{1,3}\d{1,3})\/(\d+(?:\.\d+)?)$/);
  if (!match) return null;

  return {
    code: match[1].toUpperCase(),
    value: match[2]
  };
}

function parseCountCommand(text) {
  const clean = normalizeText(text).replace(/\s+/g, "");
  const match = clean.match(/^([A-Za-z]{1,3}\d{1,3})\/카운트(\d+)$/i);
  if (!match) return null;

  const count = Number(match[2]);
  if (!Number.isInteger(count) || count < 1) return null;

  return {
    code: match[1].toUpperCase(),
    count
  };
}

function parseCustomerRegisterCommand(text) {
  const clean = normalizeText(text);
  const parts = clean.split("/").map(part => part.trim()).filter(Boolean);
  if (parts.length < 4 || parts.length > 5) return null;

  // 고객등록 명령어:
  // 기존: 관리자명/코드(상품금액)/대출금/공제
  // 신규: 관리자명/코드(상품금액)/고객명/대출금/공제
  // 예: 유나/KN56(130,000)/-30/5
  // 예: 유나/KN56(130,000)/PORNTHIP KAMHANGPOL/-30/5
  const adminName = parts[0];
  const productName = parts[1];

  let customerName = "";
  let loanToken = "";
  let cutToken = "";

  if (parts.length === 4) {
    loanToken = parts[2];
    cutToken = parts[3] ?? "0";
  } else {
    // 5개 항목인 경우 기본은 신규 형식(고객명 포함)으로 처리한다.
    // 혹시 예전식으로 관리자/상품/대출/공제/고객명을 입력한 경우도 감지해서 유지한다.
    const thirdLooksLoan = /^-?\s*\d+(?:[.,]\d+)?\s*$/.test(String(parts[2] || ""));
    if (thirdLooksLoan && /^-/.test(String(parts[2] || "").trim())) {
      loanToken = parts[2];
      cutToken = parts[3] ?? "0";
      customerName = parts[4] ?? "";
    } else {
      customerName = parts[2] ?? "";
      loanToken = parts[3];
      cutToken = parts[4] ?? "0";
    }
  }

  // 기존 명령어와 충돌 방지: 첫 항목이 코드(KN56 등)면 고객등록으로 보지 않는다.
  if (/^[A-Za-z]{1,3}\d{1,3}$/i.test(adminName.replace(/\s+/g, ""))) return null;
  if (!/[A-Za-z]{1,3}\d{1,3}/i.test(productName) || !/\(/.test(productName)) return null;

  const loanParsed = parseLoanRequiredValue(loanToken);
  if (loanParsed.error) return { error: loanParsed.error };

  const cutParsed = parseCutRequiredValue(cutToken);
  if (cutParsed.error) return { error: cutParsed.error };

  const productCode = extractProductCode(productName);
  if (!productCode) {
    return { error: "⚠️ 상품종류에는 코드가 포함되어야 합니다. 예: KN56(130,000)" };
  }

  const productAmount = extractProductAmount(productName);
  if (!productAmount) {
    return { error: "⚠️ 상품종류에서 상품금액을 찾지 못했습니다. 예: KN56(130,000)" };
  }

  return {
    adminName,
    productName,
    productCode,
    customerName,
    loanAmount: loanParsed.value,
    cut: cutParsed.value,
    productAmount
  };
}


const CHECK_OVER_MANAGER_MAP = {
  OI: "오이",
  O: "오이",
  NA: "큰나비",
  KN: "유나",
  ZD: "메이",
  ZHP: "메이2",
  ZPP: "폼",
  GT: "넙땅",
  MU: "문아",
  MO: "모나",
  JB: "수연",
  TT: "지아",
  KO: "콥"
};

function getAdminNameByCustomerCode(code) {
  const raw = String(code || "").trim().toUpperCase().replace(/\s+/g, "");
  const match = raw.match(/^([A-Z]{1,3})\d{1,3}$/);
  if (!match) return null;

  const prefix = match[1];
  return CHECK_OVER_MANAGER_MAP[prefix] || null;
}

function parseLooseNumberToken(value) {
  const raw = String(value ?? "")
    .replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/[，]/g, ",")
    .replace(/[ㆍ·]/g, ".")
    // 관리자들이 붙이는 단위는 먼저 제거한다.
    // 예: 300,000원 / 300000w / 300000 W / 300000 วอน
    .replace(/วอน|원|won|บาท|krw|₩|w/gi, " ")
    .trim();

  if (!raw || raw === "-") return null;

  const match = raw.match(/-?\d[\d,.\s]*/);
  if (!match) return null;

  let token = match[0].replace(/\s+/g, "");
  if (!token) return null;

  // 300.000처럼 천 단위 구분자로 마침표를 쓴 경우는 300000으로 보정한다.
  // 32.7처럼 소수점 의미가 분명한 경우는 그대로 둔다.
  if (/^-?\d{1,3}(?:\.\d{3})+$/.test(token) && !token.includes(",")) {
    token = token.replace(/\./g, "");
  }

  token = token.replace(/,/g, "");
  const n = Number(token);
  return Number.isFinite(n) ? n : null;
}

function normalizeWonLikeAmount(value) {
  const n = parseLooseNumberToken(value);
  if (!Number.isFinite(n)) return null;
  const abs = Math.abs(n);

  // 30 / 32.7 / 5처럼 만원 단위로 축약한 값은 원화 금액으로 환산한다.
  // 300000 / 327000 / 50000처럼 실제 원 단위로 쓴 값은 그대로 둔다.
  if (abs > 0 && abs < 1000) {
    return Math.round(abs * 10000);
  }

  return Math.round(abs);
}

function normalizeProductWonAmountFromCheckOver(value) {
  const n = parseLooseNumberToken(value);
  if (!Number.isFinite(n)) return null;
  const abs = Math.abs(n);

  // 상품금액은 변동값이므로 13 → 130,000 같은 추측 보정은 하지 않는다.
  // 실제 금액(예: 130000 / 130,000 / 130.000)만 허용한다.
  if (abs < 1000) return null;
  return Math.round(abs);
}

function normalizeLoanUnitFromCheckOver(value) {
  const n = parseLooseNumberToken(value);
  if (!Number.isFinite(n)) return null;

  const abs = Math.abs(n);
  const unit = abs < 1000 ? abs : abs / 10000;
  if (!Number.isFinite(unit) || unit <= 0) return null;

  const normalized = -Number(formatAmountValue(unit));

  // 체크오버 대출금은 300,000 / 400,000 / 500,000만 허용한다.
  if (![ -30, -40, -50 ].includes(normalized)) return null;
  return normalized;
}

function normalizeCutUnitFromCheckOver(value) {
  const raw = String(value ?? "").trim();
  const compact = normalizeText(raw).replace(/\s+/g, "").toLowerCase();

  // 공제 없음: 빈칸 / 0 / 0.0 / - / 없음 / ไม่มี 등은 모두 0으로 처리한다.
  if (!compact || compact === "-" || compact === "0" || compact === "0.0" || compact === "없음" || compact === "ไม่มี") {
    return 0;
  }

  const n = parseLooseNumberToken(value);
  if (!Number.isFinite(n)) return null;

  const abs = Math.abs(n);
  const unit = abs < 1000 ? abs : abs / 10000;
  if (!Number.isFinite(unit) || unit < 0) return null;

  return Number(formatAmountValue(unit));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripCheckOverPrefix(line) {
  return String(line || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/^[\s👉▶️💵👌🏻👌✅❌⚠️\-\*•:：=]+/u, "")
    .trim();
}

function getCheckOverField(text, labels) {
  const lines = String(text || "").split(/\r?\n/);
  const normalizedLabels = labels.map(label => String(label || "").trim()).filter(Boolean);

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = String(lines[i] || "");
    const line = stripCheckOverPrefix(rawLine);
    if (!line) continue;

    for (const label of normalizedLabels) {
      const labelPattern = escapeRegExp(label).replace(/\ /g, "\\s*").replace(/\//g, "\\s*\/\\s*");
      const direct = line.match(new RegExp("^\\s*" + labelPattern + "\\s*[:：=]?\\s*(.*)$", "i"));
      if (direct) {
        const value = String(direct[1] || "").trim();
        return value || getNextCheckOverValueLine(lines, i);
      }
    }

    // 콜론 뒤 공백이 없거나 라벨 주변 공백/기호가 섞인 경우를 한 번 더 처리한다.
    const compactLine = line.replace(/\s+/g, "").toLowerCase();
    for (const label of normalizedLabels) {
      const compactLabel = String(label).replace(/\s+/g, "").toLowerCase();
      if (!compactLine.startsWith(compactLabel)) continue;

      let value = line.slice(String(label).length).replace(/^\s*[:：=]?\s*/, "").trim();
      if (!value) {
        const compactValue = compactLine.slice(compactLabel.length).replace(/^[:：=]/, "").trim();
        value = compactValue;
      }
      if (value) return value;
    }
  }

  return "";
}


function normalizeCheckOverCustomerName(value) {
  return normalizeText(value)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function isCheckOverLabelLine(line) {
  const stripped = stripCheckOverPrefix(line).replace(/\s+/g, "").toLowerCase();
  if (!stripped) return false;
  const labels = [
    "รหัส", "code", "코드",
    "ยอดโอน", "total", "대출금", "송금",
    "ยอดสินค้า", "สินค้า", "상품금액", "상품",
    "หัก", "cut", "공제",
    "ชื่อ", "name", "고객명", "이름",
    "เลขบัญชี/ธนาคาร", "เลขบัญชี", "accountnumber", "account", "계좌"
  ];
  return labels.some(label => stripped.startsWith(String(label).replace(/\s+/g, "").toLowerCase()));
}

function getNextCheckOverValueLine(lines, startIndex) {
  for (let j = startIndex + 1; j < Math.min(lines.length, startIndex + 4); j += 1) {
    const nextLine = stripCheckOverPrefix(lines[j]);
    if (!nextLine) continue;
    if (isCheckOverLabelLine(nextLine)) return "";
    return nextLine.trim();
  }
  return "";
}

function buildCheckOverFormatGuide(problemLabels = [], options = {}) {
  const labels = Array.isArray(problemLabels) ? problemLabels.filter(Boolean) : [];
  const problemText = labels.length
    ? labels.map(label => `- ${label}`).join("\n")
    : "- กรุณาตรวจสอบข้อมูล";

  return [
    "⚠️ กรุณาตรวจสอบ Check Over",
    "",
    "รายการที่ต้องแก้ไข:",
    problemText
  ].join("\n");
}

function isCheckOverGuideCommand(text) {
  const raw = normalizeText(text).trim().toLowerCase();
  return raw === "/co" || raw === "co" || raw === "checkover" || raw === "check over";
}

function buildCheckOverTemplateText() {
  return [
    "💵 BOSS 💵 👌🏻 Check Over",
    "",
    "👉 รหัส:",
    "👉 ยอดโอน:",
    "👉 ยอดสินค้า:",
    "👉 หัก:",
    "👉 ชื่อ:",
    "👉 เลขบัญชี / ธนาคาร:",
    "",
    "━━━━━━━━━━━━━━━━━━",
    "📌 Example",
    "",
    "💵 BOSS 💵 👌🏻 Check Over",
    "",
    "👉 รหัส: KN56",
    "👉 ยอดโอน: 300,000",
    "👉 ยอดสินค้า: 130,000",
    "👉 หัก: 50,000",
    "👉 ชื่อ: NAME",
    "👉 เลขบัญชี / ธนาคาร: ACCOUNT NUMBER / BANK NAME",
    "",
    "📌 หมายเหตุ",
    "- ยอดโอน ใช้ได้เฉพาะ 300,000 / 400,000 / 500,000",
    "- หัก ถ้าไม่มี ให้เว้นว่าง หรือใส่ 0",
    "- จำนวนเงินใส่ comma ได้ เช่น 300,000"
  ].join("\n");
}

function parseCheckOverCommand(text) {
  const raw = normalizeText(text);

  // Check Over 문구가 들어간 경우에만 Check Over 양식으로 처리한다.
  // 일반 대출 안내/상환표에 รหัส, ยอดโอน 같은 단어가 있어도 오탐하지 않도록 제한한다.
  if (!/check\s*over/i.test(raw)) return null;

  const code = getCheckOverField(raw, ["รหัส", "code", "코드"]).replace(/\s+/g, "").toUpperCase();
  const transferRaw = getCheckOverField(raw, ["ยอดโอน", "total", "대출금", "송금"]);
  const productRaw = getCheckOverField(raw, ["ยอดสินค้า", "สินค้า", "상품금액", "상품"]);
  const cutRaw = getCheckOverField(raw, ["หัก", "cut", "공제"]);
  const customerName = normalizeCheckOverCustomerName(getCheckOverField(raw, ["ชื่อ", "name", "고객명", "이름"]));
  const account = getCheckOverField(raw, ["เลขบัญชี / ธนาคาร", "เลขบัญชี", "account number", "account", "계좌"]);

  if (!code && !transferRaw && !productRaw && !cutRaw && !customerName && !account) return null;

  const missing = [];
  if (!code) missing.push("รหัส");
  if (!transferRaw) missing.push("ยอดโอน");
  if (!productRaw) missing.push("ยอดสินค้า");
  // หัก은 선택값이다. 비어 있거나 없으면 공제 0으로 처리한다.
  if (!customerName) missing.push("ชื่อ");
  if (missing.length) return { error: buildCheckOverFormatGuide(missing) };

  if (!/^[A-Z]{1,3}\d{1,3}$/.test(code)) {
    return { error: buildCheckOverFormatGuide(["รหัส (ตัวอย่าง: KN56)"]) };
  }

  const adminName = getAdminNameByCustomerCode(code);
  if (!adminName) {
    return { error: buildCheckOverFormatGuide([`รหัสผู้ดูแลไม่ถูกต้อง (${code.replace(/\d+$/, "")})`]) };
  }

  const productAmount = normalizeProductWonAmountFromCheckOver(productRaw);
  if (!productAmount) {
    return { error: buildCheckOverFormatGuide(["ยอดสินค้า (ตัวอย่าง: 130000 หรือ 130,000)"]) };
  }

  const loanAmount = normalizeLoanUnitFromCheckOver(transferRaw);
  if (!Number.isFinite(loanAmount) || loanAmount >= 0) {
    return { error: buildCheckOverFormatGuide(["ยอดโอน ใช้ได้เฉพาะ 300000 / 400000 / 500000"]) };
  }

  const cut = normalizeCutUnitFromCheckOver(cutRaw);
  if (!Number.isFinite(cut)) {
    return { error: buildCheckOverFormatGuide(["หัก"]) };
  }

  const productName = `${code}(${productAmount.toLocaleString("ko-KR")})`;

  return {
    source: "checkover",
    adminName,
    productName,
    productCode: code,
    customerName,
    account,
    loanAmount,
    cut,
    productAmount,
    raw: {
      transferRaw,
      productRaw,
      cutRaw
    }
  };
}

function buildCheckOverAnalysisText(command) {
  return [
    "✅ Check Over 확인",
    "",
    `관리자 : ${command.adminName}`,
    `코드 : ${command.productCode}`,
    `고객명 : ${command.customerName || "-"}`,
    `상품금액 : ${command.productAmount.toLocaleString("ko-KR")}`,
    `대출금 : ${formatAmountValue(command.loanAmount)}`,
    `공제 : ${formatAmountValue(command.cut)}`,
    "",
    "등록하시겠습니까?"
  ].join("\n");
}

function buildCheckOverConfirmMessages(command, options = {}) {
  const params = new URLSearchParams();
  params.set("checkover", "1");
  params.set("action", "confirm");
  params.set("admin", command.adminName);
  params.set("code", command.productCode);
  params.set("productAmount", String(command.productAmount));
  params.set("customerName", command.customerName || "");
  params.set("loanAmount", String(command.loanAmount));
  params.set("cut", String(command.cut));

  const cancelParams = new URLSearchParams(params);
  cancelParams.set("action", "cancel");

  const analysisText = options.approvalNotice
    ? [`📥 ${RECEIPT_APPROVAL_GROUP_CODE} Check Over 등록 대기`, "", buildCheckOverAnalysisText(command)].join("\n")
    : buildCheckOverAnalysisText(command);

  return [
    buildTextMessage(analysisText),
    {
      type: "template",
      altText: "Check Over 등록하시겠습니까?",
      template: {
        type: "buttons",
        text: `${command.productCode}(${command.productAmount.toLocaleString("ko-KR")}) 등록하시겠습니까?`,
        actions: [
          {
            type: "postback",
            label: "등록",
            data: params.toString(),
            displayText: "등록"
          },
          {
            type: "postback",
            label: "취소",
            data: cancelParams.toString(),
            displayText: "취소"
          }
        ]
      }
    }
  ];
}

async function pushCheckOverConfirmToApprovalGroup(event, command) {
  try {
    const sourceGroupId = getLineSourceGroupId(event);
    if (!sourceGroupId) return;

    const accessToken = SHEET_ID ? await getGoogleAccessToken() : null;
    const approvalGroupId = await getReceiptApprovalGroupId(accessToken);
    if (!approvalGroupId || approvalGroupId === sourceGroupId) return;

    await pushToLineMessages(approvalGroupId, buildCheckOverConfirmMessages(command, { approvalNotice: true }));
  } catch (err) {
    const errorText = getLinePushErrorMessage(err);
    console.error(`[CHECKOVER APPROVAL PUSH FAIL] code=${command?.productCode || "-"} error=${errorText}`);
  }
}

function parseCheckOverPostback(event) {
  const data = String(event?.postback?.data || "");
  const params = new URLSearchParams(data);
  if (params.get("checkover") !== "1") return null;

  const action = String(params.get("action") || "").trim();
  if (!["confirm", "cancel"].includes(action)) return null;

  const code = String(params.get("code") || "").trim().toUpperCase();
  const adminName = String(params.get("admin") || "").trim();
  const productAmount = Number(params.get("productAmount"));
  const customerName = String(params.get("customerName") || "").trim();
  const loanAmount = Number(params.get("loanAmount"));
  const cutToken = String(params.get("cut") || "").trim();
  const cut = Number(cutToken);

  if (!code || !adminName || !Number.isFinite(productAmount) || !Number.isFinite(loanAmount) || !Number.isFinite(cut)) {
    return { action, error: "⚠️ ข้อมูล Check Over ไม่ถูกต้อง กรุณาส่งใหม่อีกครั้ง" };
  }

  return {
    action,
    adminName,
    productName: `${code}(${productAmount.toLocaleString("ko-KR")})`,
    productCode: code,
    customerName,
    loanAmount,
    cut,
    productAmount
  };
}

async function handleCheckOverPostback(event, checkover) {
  if (checkover.error) {
    await replyToLine(event.replyToken, checkover.error);
    return;
  }

  // Check Over 등록/취소는 지정된 Check Over 관리자만 가능.
  if (!canManageCheckOver(event)) {
    await replyUnauthorized(event);
    return;
  }

  if (checkover.action === "cancel") {
    await replyToLine(event.replyToken, `취소되었습니다.\n${checkover.productCode || ""}`);
    return;
  }

  const reply = await writeCustomerRegistration(checkover);
  await replyToLine(event.replyToken, reply);
}


function extractProductCode(productName) {
  const match = String(productName || "").match(/([A-Za-z]{1,3}\d{1,3})/);
  return match ? match[1].toUpperCase() : null;
}

function extractProductAmount(productName) {
  const raw = String(productName || "")
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .replace(/[，]/g, ",")
    .replace(/[ㆍ·]/g, ".");

  // 1순위: 괄호 안 금액을 읽는다.
  // 예: PP01(130,000), PP01(130000), PP01(130,000원), PP01（130,000）
  const insideParen = raw.match(/\(([^)]*\d[^)]*)\)/);
  const candidates = [];
  if (insideParen) candidates.push(insideParen[1]);
  candidates.push(raw);

  for (const candidate of candidates) {
    const amountMatch = String(candidate).match(/\d[\d,._\s원บาท]*/);
    if (!amountMatch) continue;

    const digits = amountMatch[0].replace(/\D/g, "");
    if (!digits) continue;

    const amount = Number(digits);
    if (Number.isFinite(amount) && amount > 0) return amount;
  }

  return null;
}

function parseRegisterGroupCommand(text) {
  const clean = normalizeText(text).replace(/\s+/g, "");
  const match = clean.match(/^([A-Za-z]{1,3}\d{1,3})\/등록$/i);
  if (!match) return null;

  return {
    code: match[1].toUpperCase()
  };
}


function parseCloseCommand(text) {
  const clean = normalizeText(text).replace(/\s+/g, "");
  const match = clean.match(/^([A-Za-z]{1,3}\d{1,3})\/(종료|종결)$/i);
  if (!match) return null;

  return {
    code: match[1].toUpperCase()
  };
}

function parseCreditCheckCommand(text) {
  const clean = normalizeText(text);
  const match = clean.match(/^(.+?)\/조회$/i);
  if (!match) return null;

  const rawKeyword = normalizeText(match[1]);
  if (!rawKeyword) return null;

  const compactKeyword = rawKeyword.replace(/\s+/g, "");
  const codeMatch = compactKeyword.match(/^([A-Za-z]{1,3}\d{1,3})$/);
  if (codeMatch) {
    return { type: "code", keyword: codeMatch[1].toUpperCase() };
  }

  return { type: "name", keyword: rawKeyword };
}


function parseYearMonthValue(value) {
  const raw = String(value ?? "").trim();
  const compact = raw.replace(/[.\-_/년월\s]/g, "");

  let yy = null;
  let mm = null;

  if (/^\d{4}$/.test(compact)) {
    yy = Number(compact.slice(0, 2));
    mm = Number(compact.slice(2, 4));
  } else if (/^\d{6}$/.test(compact) && compact.startsWith("20")) {
    yy = Number(compact.slice(2, 4));
    mm = Number(compact.slice(4, 6));
  }

  if (!Number.isInteger(yy) || !Number.isInteger(mm) || yy < 0 || mm < 1 || mm > 12) {
    return null;
  }

  return `${String(yy).padStart(2, "0")}${String(mm).padStart(2, "0")}`;
}

function getFullYearFromYearMonth(yearMonth) {
  const yy = Number(String(yearMonth).slice(0, 2));
  return 2000 + yy;
}

function getDaysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function parseNumericRequiredValue(value, label) {
  const raw = String(value ?? "").trim();
  const n = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(n)) {
    return { error: `⚠️ ${label}은 숫자로 입력해주세요. 예: -30 또는 5` };
  }
  return { value: n };
}

function getCustomerRegisterFormatGuide() {
  return "형식\n관리자명/코드(상품금액)/대출금액/공제금액\n관리자명/코드(상품금액)/고객명/대출금액/공제금액\n\n예시\n유나/KN56(130,000)/-30/5\n유나/KN56(130,000)/PORNTHIP KAMHANGPOL/-30/5";
}

function parseLoanRequiredValue(value) {
  const raw = String(value ?? "").trim();

  // 고객등록 명령어의 대출금액은 반드시 -30, -40, -50만 허용한다.
  // 30, 40, 50, -03, -300000, -32.7 같은 값은 오등록 방지를 위해 거절한다.
  if (!["-30", "-40", "-50"].includes(raw)) {
    return {
      error: `❌ 대출금액은 -30, -40, -50만 사용할 수 있습니다.

${getCustomerRegisterFormatGuide()}`
    };
  }

  return { value: Number(raw) };
}

function parseCutRequiredValue(value) {
  const raw = String(value ?? "").trim();
  if (raw === "-") return { value: "-" };
  const n = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(n)) {
    return { error: "⚠️ Cut은 숫자 또는 - 로 입력해주세요. 예: 5 또는 -" };
  }
  return { value: n };
}

function getLoanPrincipalUnit(loanAmount) {
  const amount = Math.abs(Number(loanAmount));
  if (!Number.isFinite(amount)) return null;

  // 명령어 대출금은 -30 / -40 / -50 처럼 만원 단위로 입력한다.
  if (amount === 30) return 30;
  if (amount === 40) return 40;
  if (amount === 50) return 50;

  return null;
}

function getRepaymentPlanByProductAmount(productAmount, loanAmount = null) {
  const principalUnit = getLoanPrincipalUnit(loanAmount);

  const plansByPrincipal = {
    30: {
      // 300,000원 이미지 기준
      25000: { intervalDays: 1, repaymentCount: 10, label: "ดอกลอย 25,000 × 10วัน" },
      130000: { intervalDays: 7, repaymentCount: 4, label: "ดอกลอยรายอาทิตย์ 130,000 × 4งวด" },
      145000: { intervalDays: 3, repaymentCount: 4, label: "ราย 3 วัน 145,000 × 4งวด" },
      175000: { intervalDays: 5, repaymentCount: 4, label: "ราย 5 วัน 175,000 × 4งวด" },
      195000: { intervalDays: 7, repaymentCount: 4, label: "ราย 7 วัน 195,000 × 4งวด" },
      50000: { intervalDays: 1, repaymentCount: 10, label: "ทุกวัน 10 วัน 50,000 × 10งวด" },
      45000: { intervalDays: 1, repaymentCount: 12, label: "ทุกวัน 12 วัน 45,000 × 12งวด" },
      40000: { intervalDays: 1, repaymentCount: 15, label: "ทุกวัน 15 วัน 40,000 × 15งวด" }
    },
    40: {
      // 400,000원 이미지 기준
      35000: { intervalDays: 1, repaymentCount: 10, label: "ดอกลอย 35,000 × 10วัน" },
      160000: { intervalDays: 7, repaymentCount: 4, label: "ดอกลอยรายอาทิตย์ 160,000 × 4งวด" },
      185000: { intervalDays: 3, repaymentCount: 4, label: "ราย 3 วัน 185,000 × 4งวด" },
      215000: { intervalDays: 5, repaymentCount: 4, label: "ราย 5 วัน 215,000 × 4งวด" },
      235000: { intervalDays: 7, repaymentCount: 4, label: "ราย 7 วัน 235,000 × 4งวด" },
      65000: { intervalDays: 1, repaymentCount: 10, label: "ทุกวัน 10 วัน 65,000 × 10งวด" },
      60000: { intervalDays: 1, repaymentCount: 12, label: "ทุกวัน 12 วัน 60,000 × 12งวด" },
      55000: { intervalDays: 1, repaymentCount: 15, label: "ทุกวัน 15 วัน 55,000 × 15งวด" }
    },
    50: {
      // 500,000원 이미지 기준
      45000: { intervalDays: 1, repaymentCount: 10, label: "ดอกลอย 45,000 × 10วัน" },
      190000: { intervalDays: 7, repaymentCount: 4, label: "ดอกลอยรายอาทิตย์ 190,000 × 4งวด" },
      225000: { intervalDays: 3, repaymentCount: 4, label: "ราย 3 วัน 225,000 × 4งวด" },
      255000: { intervalDays: 5, repaymentCount: 4, label: "ราย 5 วัน 255,000 × 4งวด" },
      275000: { intervalDays: 7, repaymentCount: 4, label: "ราย 7 วัน 275,000 × 4งวด" },
      80000: { intervalDays: 1, repaymentCount: 10, label: "ทุกวัน 10 วัน 80,000 × 10งวด" },
      70000: { intervalDays: 1, repaymentCount: 12, label: "ทุกวัน 12 วัน 70,000 × 12งวด" },
      60000: { intervalDays: 1, repaymentCount: 15, label: "ทุกวัน 15 วัน 60,000 × 15งวด" }
    }
  };

  if (principalUnit && plansByPrincipal[principalUnit]) {
    return plansByPrincipal[principalUnit][productAmount] || null;
  }

  // 대출금이 없거나 인식되지 않는 기존 함수 호출 대비용.
  // 단, 45,000 / 60,000 처럼 금액만으로 상품이 갈리는 경우에는 null을 반환해서 오등록을 막는다.
  const fallback = {};
  for (const [principal, table] of Object.entries(plansByPrincipal)) {
    for (const [amount, plan] of Object.entries(table)) {
      if (fallback[amount] && JSON.stringify(fallback[amount]) !== JSON.stringify(plan)) {
        fallback[amount] = null;
      } else if (!(amount in fallback)) {
        fallback[amount] = plan;
      }
    }
  }

  return fallback[String(productAmount)] || null;
}
function buildRepaymentCells(command) {
  const plan = getRepaymentPlanByProductAmount(command.productAmount, command.loanAmount);
  if (!plan) {
    return { error: `⚠️ ${command.productAmount.toLocaleString("ko-KR")}원 상품의 상환방식이 등록되어 있지 않습니다.` };
  }

  const cells = Array(DATE_END_COLUMN_INDEX - DATE_START_COLUMN_INDEX + 1).fill("");
  const lastDayOfMonth = command.lastDayOfMonth || 31;
  const startIndex = command.startDay - 1;
  if (startIndex < 0 || startIndex >= lastDayOfMonth || startIndex >= cells.length) {
    return { error: `⚠️ 시작 날짜가 해당 월의 날짜 범위를 벗어났습니다. 이 달은 ${lastDayOfMonth}일까지 있습니다.` };
  }

  cells[startIndex] = formatAmountValue(command.cut);

  const isNoCut = String(command.cut).trim() === "-";

  if (isNoCut && plan.intervalDays === 1) {
    // Cut이 없는 매일상환 상품은 당일 칸에 '-'만 표시하고,
    // 다음날부터 실제 상환일자를 repaymentCount회 카운트한다.
    for (let i = 1; i <= plan.repaymentCount; i += 1) {
      const dueDay = command.startDay + i;
      if (dueDay > lastDayOfMonth) continue;

      const dueIndex = dueDay - 1;
      if (dueIndex >= 0 && dueIndex < cells.length && isBlankCell(cells[dueIndex])) {
        cells[dueIndex] = "$";
      }
    }
  } else {
    // 기존 규칙 유지: 당일부터 카운트해서 intervalDays 간격으로 상환표시.
    for (let i = 0; i < plan.repaymentCount; i += 1) {
      const dueDay = command.startDay + (plan.intervalDays - 1) + plan.intervalDays * i;
      if (dueDay > lastDayOfMonth) continue;

      const dueIndex = dueDay - 1;
      if (dueIndex >= 0 && dueIndex < cells.length && isBlankCell(cells[dueIndex])) {
        cells[dueIndex] = "$";
      }
    }
  }

  return { cells, plan, lastDayOfMonth, noCut: isNoCut };
}

function placeRegistrationCell(topCells, bottomCells, todayInfo, dayOffsetFromStart, value) {
  const lastDayOfMonth = getDaysInMonth(todayInfo.year, todayInfo.month);
  const absoluteDay = todayInfo.day + dayOffsetFromStart;

  // 고객등록 시트는 1고객 2행 구조다.
  // 윗줄(topRows): 고객정보 + 다음달 1일부터 이어지는 카운트
  // 아랫줄(bottomRows): 이번달 오늘 날짜부터 말일까지의 카운트
  if (absoluteDay <= lastDayOfMonth) {
    const index = absoluteDay - 1;
    if (index >= 0 && index < bottomCells.length) bottomCells[index] = value;
    return;
  }

  const nextMonthDay = absoluteDay - lastDayOfMonth;
  const index = nextMonthDay - 1;
  if (index >= 0 && index < topCells.length) topCells[index] = value;
}

function buildRegistrationRepaymentRows(command, todayInfo = null) {
  const today = todayInfo || getKoreaToday();
  const plan = getRepaymentPlanByProductAmount(command.productAmount, command.loanAmount);
  if (!plan) {
    return { error: `⚠️ ${command.productAmount.toLocaleString("ko-KR")}원 상품의 상환방식이 등록되어 있지 않습니다.` };
  }

  const width = DATE_END_COLUMN_INDEX - DATE_START_COLUMN_INDEX + 1;
  const topCells = Array(width).fill("");
  const bottomCells = Array(width).fill("");
  const isDashCut = String(command.cut).trim() === "-";
  const cutNumber = isDashCut ? 0 : Number(command.cut);
  const hasCut = Number.isFinite(cutNumber) && cutNumber > 0;
  const repaymentUnit = command.productAmount / 10000;
  const repaymentValueText = formatAmountValue(repaymentUnit);

  if (plan.intervalDays === 1) {
    // 명령어의 선공제는 만원 단위로 입력한다.
    // 예: 25,000원 상품 + /5 => 5만원 선공제 => 2.5, 2.5 두 칸 선카운트
    const prepaidCount = hasCut ? Math.min(plan.repaymentCount, Math.floor(cutNumber / repaymentUnit)) : 0;

    for (let i = 0; i < plan.repaymentCount; i += 1) {
      const value = i < prepaidCount ? repaymentValueText : "$";
      placeRegistrationCell(topCells, bottomCells, today, i, value);
    }

    return { topCells, bottomCells, plan, prepaidCount };
  }

  // 3일/5일/7일 상품은 "당일 포함" 계산이다.
  // 예: 오늘 포함 7일째가 첫 상환일이므로 offset은 6일이다.
  const intervalOffset = Math.max(0, plan.intervalDays - 1);
  const lastOffset = intervalOffset + plan.intervalDays * (plan.repaymentCount - 1);
  for (let offset = 0; offset <= lastOffset; offset += 1) {
    placeRegistrationCell(topCells, bottomCells, today, offset, "-");
  }

  placeRegistrationCell(topCells, bottomCells, today, 0, hasCut ? formatAmountValue(command.cut) : "-");

  for (let i = 0; i < plan.repaymentCount; i += 1) {
    const dueOffset = intervalOffset + plan.intervalDays * i;
    placeRegistrationCell(topCells, bottomCells, today, dueOffset, "$");
  }

  return { topCells, bottomCells, plan, prepaidCount: 0 };
}

function formatKoreaDateValue(todayInfo = null) {
  const today = todayInfo || getKoreaToday();
  return `${today.year}-${String(today.month).padStart(2, "0")}-${String(today.day).padStart(2, "0")}`;
}

function formatKoreaYearMonthDropdownValue(todayInfo = null) {
  const today = todayInfo || getKoreaToday();
  const yy = String(today.year).slice(-2);
  const mm = String(today.month).padStart(2, "0");
  return `${yy}/${mm}`;
}

function isBlankCell(value) {
  return value === undefined || value === null || String(value).trim() === "";
}

function isInputCandidateCell(value) {
  const v = String(value ?? "").trim();
  return v === "-" || v === "$";
}

function isActualPaymentCell(value) {
  const v = String(value ?? "").trim();
  return /^-?\d+(?:\.\d+)?$/.test(v);
}

function parseAmountValue(value) {
  const n = Number(String(value ?? "").trim());
  return Number.isFinite(n) ? n : null;
}

function formatAmountValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value ?? "");
  return String(Math.round((n + Number.EPSILON) * 1000) / 1000).replace(/\.0+$/, "");
}

async function getGoogleAccessToken() {
  if (!GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_PRIVATE_KEY) {
    throw new Error("Google service account environment variables are missing.");
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: GOOGLE_SERVICE_ACCOUNT_EMAIL,
    scope: GOOGLE_SHEETS_SCOPE,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  };

  const unsignedToken = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = crypto
    .createSign("RSA-SHA256")
    .update(unsignedToken)
    .sign(GOOGLE_PRIVATE_KEY, "base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  const jwt = `${unsignedToken}.${signature}`;

  const response = await axios.post(
    "https://oauth2.googleapis.com/token",
    new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt
    }).toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  return response.data.access_token;
}

async function getSheetValues(accessToken) {
  const range = `'${escapeSheetName(SHEET_NAME)}'!A:AP`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}`;
  const response = await axios.get(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  return response.data.values || [];
}

async function updateSheetCell(accessToken, rowNumber, columnIndex0, value) {
  const columnLetter = columnNumberToLetter(columnIndex0 + 1);
  const range = `'${escapeSheetName(SHEET_NAME)}'!${columnLetter}${rowNumber}`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;

  await axios.put(
    url,
    { range, majorDimension: "ROWS", values: [[value]] },
    { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }
  );

  return `${columnLetter}${rowNumber}`;
}

async function updateSheetRange(accessToken, startRowNumber, startColumnIndex0, values) {
  const rowCount = values.length;
  const columnCount = values.reduce((max, row) => Math.max(max, row.length), 0);
  if (rowCount < 1 || columnCount < 1) return null;

  const startColumnLetter = columnNumberToLetter(startColumnIndex0 + 1);
  const endColumnLetter = columnNumberToLetter(startColumnIndex0 + columnCount);
  const endRowNumber = startRowNumber + rowCount - 1;
  const range = `'${escapeSheetName(SHEET_NAME)}'!${startColumnLetter}${startRowNumber}:${endColumnLetter}${endRowNumber}`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;

  const response = await axios.put(
    url,
    { range, majorDimension: "ROWS", values },
    { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }
  );

  return response.data;
}


async function appendSheetRows(accessToken, rows) {
  const range = `'${escapeSheetName(SHEET_NAME)}'!A:AP`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

  const response = await axios.post(
    url,
    { range, majorDimension: "ROWS", values: rows },
    { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }
  );

  return response.data;
}

async function updateSheetRows(accessToken, startRowNumber, rows) {
  const endRowNumber = startRowNumber + rows.length - 1;
  const endColumnLetter = columnNumberToLetter(DATE_END_COLUMN_INDEX + 1);
  const range = `'${escapeSheetName(SHEET_NAME)}'!A${startRowNumber}:${endColumnLetter}${endRowNumber}`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;

  const response = await axios.put(
    url,
    { range, majorDimension: "ROWS", values: rows },
    { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }
  );

  return response.data;
}

function hasCustomerRegisterContent(row) {
  const cells = row || [];
  for (let i = 0; i <= DATE_END_COLUMN_INDEX; i += 1) {
    // J/K열은 빈 양식에도 수식이 있을 수 있어서 신규 입력 위치 판단에서 제외한다.
    if (i === 9 || i === 10) continue;
    if (!isBlankCell(cells[i])) return true;
  }
  return false;
}

function parseCustomerNo(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const no = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(no) || no < 1) return null;
  return Math.floor(no);
}

function isRegisteredCustomerTopRow(row) {
  const no = parseCustomerNo(row?.[0]);
  if (!no) return false;

  // 고객 1명은 2행 구조이고, 실제 등록 여부는 A열 번호만으로 판단하면 안 된다.
  // 시트에는 689~1000처럼 번호만 미리 깔려있는 빈 양식 행이 있으므로
  // F열 상품코드가 있거나, 고객명/날짜/금액 중 실제 입력값이 있는 경우만 등록된 고객으로 본다.
  const productName = String(row?.[5] || "").trim();
  if (extractProductCode(productName)) return true;

  const customerName = String(row?.[6] || "").trim();
  const dateValue = String(row?.[7] || "").trim();
  const loanValue = String(row?.[8] || "").trim();
  return Boolean(customerName || dateValue || loanValue);
}

function getNextCustomerNumber(values) {
  let maxNo = 0;
  for (const row of values.slice(1)) {
    if (!isRegisteredCustomerTopRow(row)) continue;
    const no = parseCustomerNo(row?.[0]);
    if (no) maxNo = Math.max(maxNo, no);
  }
  return maxNo + 1;
}

function findNextCustomerWriteRow(values, nextNo) {
  // A열 번호 기준으로 입력 위치를 찾는다.
  // 예: 688번까지 등록되어 있고 689번 양식 행이 이미 있으면 그 행에 덮어쓴다.
  // 사용자가 700번까지 수동 등록했다면 다음 번호는 701이고, A열 701 행을 찾아 쓴다.
  const targetNo = parseCustomerNo(nextNo);
  if (targetNo) {
    for (let i = 1; i < values.length; i += 1) {
      const rowNo = parseCustomerNo(values[i]?.[0]);
      if (rowNo === targetNo) return i + 1;
    }
  }

  // 번호 양식이 아직 없으면 마지막 실제 등록 고객의 아래 2행 뒤에 쓴다.
  let lastRegisteredRowNumber = 1;
  for (let i = 1; i < values.length; i += 1) {
    if (isRegisteredCustomerTopRow(values[i])) lastRegisteredRowNumber = i + 1;
  }

  return Math.max(2, lastRegisteredRowNumber + 2);
}

function makeWritableRow(row, width) {
  const next = Array(width).fill("");
  const source = row || [];
  for (let i = 0; i < Math.min(width, source.length); i += 1) {
    next[i] = source[i] ?? "";
  }
  return next;
}

async function getSpreadsheetSheetTitles(accessToken) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?fields=sheets.properties.title`;
  const response = await axios.get(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  return (response.data.sheets || []).map(sheet => sheet.properties?.title).filter(Boolean);
}

async function getSpreadsheetSheetId(accessToken, sheetName) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?fields=sheets.properties`;
  const response = await axios.get(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  const target = (response.data.sheets || []).find(sheet => sheet.properties?.title === sheetName);
  return target?.properties?.sheetId ?? null;
}

async function ensureGroupMapSheet(accessToken) {
  const titles = await getSpreadsheetSheetTitles(accessToken);
  if (titles.includes(GROUP_MAP_SHEET_NAME)) return;

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}:batchUpdate`;
  await axios.post(
    url,
    {
      requests: [
        {
          addSheet: {
            properties: {
              title: GROUP_MAP_SHEET_NAME
            }
          }
        }
      ]
    },
    { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }
  );

  const headerRange = `'${escapeSheetName(GROUP_MAP_SHEET_NAME)}'!A1:C1`;
  const headerUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(headerRange)}?valueInputOption=USER_ENTERED`;
  await axios.put(
    headerUrl,
    { range: headerRange, majorDimension: "ROWS", values: [["코드", "그룹ID", "등록일시"]] },
    { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }
  );
}

async function getGroupMapValues(accessToken) {
  await ensureGroupMapSheet(accessToken);
  const range = `'${escapeSheetName(GROUP_MAP_SHEET_NAME)}'!A:C`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}`;
  const response = await axios.get(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  return response.data.values || [];
}

async function ensureReceiptPendingSheet(accessToken) {
  const titles = await getSpreadsheetSheetTitles(accessToken);
  if (titles.includes(RECEIPT_PENDING_SHEET_NAME)) return;

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}:batchUpdate`;
  await axios.post(
    url,
    { requests: [{ addSheet: { properties: { title: RECEIPT_PENDING_SHEET_NAME } } }] },
    { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }
  );

  const headerRange = `'${escapeSheetName(RECEIPT_PENDING_SHEET_NAME)}'!A1:O1`;
  const headerUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(headerRange)}?valueInputOption=USER_ENTERED`;
  await axios.put(
    headerUrl,
    { range: headerRange, majorDimension: "ROWS", values: [[
      "대기ID", "상태", "원본그룹ID", "승인그룹ID", "코드", "상환값", "금액원", "입금자명", "계좌번호", "이체일", "이미지키", "정보키", "유사키", "생성일시", "수정일시"
    ]] },
    { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }
  );
}

function makeReceiptPendingId(receiptKey, sourceGroupId) {
  const raw = `${receiptKey || ""}|${sourceGroupId || ""}|${Date.now()}|${Math.random()}`;
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 20);
}

async function appendReceiptPending(accessToken, item) {
  await ensureReceiptPendingSheet(accessToken);
  const nowText = getKoreaDateTimeText();
  const range = `'${escapeSheetName(RECEIPT_PENDING_SHEET_NAME)}'!A:O`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  await axios.post(
    url,
    { range, majorDimension: "ROWS", values: [[
      item.pendingId || "", item.status || "pending", item.sourceGroupId || "", item.approvalGroupId || "", item.code || "", item.sheetValue || "", item.amountWon || "", item.senderName || "", item.accountNumber || "", item.transferDate || "", item.imageKey || "", item.infoKey || "", item.nearDuplicateKey || "", nowText, nowText
    ]] },
    { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }
  );
}

function receiptPendingFromRow(row, rowNumber) {
  return {
    rowNumber,
    pendingId: String(row?.[0] || "").trim(),
    status: String(row?.[1] || "").trim() || "pending",
    sourceGroupId: String(row?.[2] || "").trim(),
    approvalGroupId: String(row?.[3] || "").trim(),
    code: String(row?.[4] || "").trim().toUpperCase(),
    sheetValue: String(row?.[5] || "").trim(),
    amountWon: normalizeWonAmount(row?.[6]),
    senderName: normalizeSenderName(row?.[7]),
    accountNumber: normalizeAccountNumber(row?.[8]),
    transferDate: normalizeTransferDate(row?.[9]),
    imageKey: String(row?.[10] || "").trim(),
    infoKey: String(row?.[11] || "").trim(),
    nearDuplicateKey: String(row?.[12] || "").trim()
  };
}

async function findReceiptPending(accessToken, pendingId) {
  const id = String(pendingId || "").trim();
  if (!id) return null;
  await ensureReceiptPendingSheet(accessToken);
  const range = `'${escapeSheetName(RECEIPT_PENDING_SHEET_NAME)}'!A:O`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}`;
  const response = await axios.get(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const values = response.data.values || [];
  for (let i = values.length - 1; i >= 1; i -= 1) {
    if (String(values[i]?.[0] || "").trim() === id) return receiptPendingFromRow(values[i], i + 1);
  }
  return null;
}

async function updateReceiptPendingStatus(accessToken, pending, status) {
  if (!pending?.rowNumber) return;
  const nowText = getKoreaDateTimeText();
  const range = `'${escapeSheetName(RECEIPT_PENDING_SHEET_NAME)}'!B${pending.rowNumber}:O${pending.rowNumber}`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
  await axios.put(
    url,
    { range, majorDimension: "ROWS", values: [[
      status, pending.sourceGroupId || "", pending.approvalGroupId || "", pending.code || "", pending.sheetValue || "", pending.amountWon || "", pending.senderName || "", pending.accountNumber || "", pending.transferDate || "", pending.imageKey || "", pending.infoKey || "", pending.nearDuplicateKey || "", "", nowText
    ]] },
    { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }
  );
}

async function registerGroupCode(command, event) {
  if (!SHEET_ID) {
    return "⚠️ GOOGLE_SHEET_ID 환경변수가 설정되지 않았습니다.";
  }

  const groupId = event?.source?.groupId || event?.source?.roomId;
  if (!groupId) {
    return "⚠️ 그룹방에서만 등록 가능합니다.";
  }

  const accessToken = await getGoogleAccessToken();
  const values = await getGroupMapValues(accessToken);
  const nowText = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date());

  let existingRowNumber = null;
  const rowsToClear = [];
  const clearedCodes = [];

  // 먼저 새 코드 등록/갱신에 필요한 행을 찾고,
  // 같은 그룹방에 남아 있는 이전 코드들은 등록 완료 후 별도로 정리한다.
  // 정리 실패가 생겨도 등록 답신은 반드시 나가도록 아래에서 try/catch로 분리한다.
  for (let i = 1; i < values.length; i += 1) {
    const code = String(values[i]?.[0] || "").trim().toUpperCase();
    const mappedGroupId = String(values[i]?.[1] || "").trim();

    if (code === command.code && existingRowNumber === null) {
      existingRowNumber = i + 1;
      continue;
    }

    if (mappedGroupId === groupId && code && code !== command.code) {
      rowsToClear.push(i + 1);
      clearedCodes.push(code);
    }
  }

  let replyText = "";

  if (existingRowNumber) {
    const range = `'${escapeSheetName(GROUP_MAP_SHEET_NAME)}'!A${existingRowNumber}:C${existingRowNumber}`;
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
    await axios.put(
      url,
      { range, majorDimension: "ROWS", values: [[command.code, groupId, nowText]] },
      { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }
    );

    replyText = `✅ ${command.code} 그룹등록 갱신완료`;
  } else {
    const range = `'${escapeSheetName(GROUP_MAP_SHEET_NAME)}'!A:C`;
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
    await axios.post(
      url,
      { range, majorDimension: "ROWS", values: [[command.code, groupId, nowText]] },
      { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }
    );

    replyText = `✅ ${command.code} 그룹등록 완료`;
  }

  if (rowsToClear.length) {
    try {
      const ranges = rowsToClear.map(rowNumber => `'${escapeSheetName(GROUP_MAP_SHEET_NAME)}'!A${rowNumber}:C${rowNumber}`);
      const clearUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values:batchClear`;
      await axios.post(
        clearUrl,
        { ranges },
        { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }
      );

      replyText += `\n🧹 기존 매핑 해제: ${clearedCodes.join(", ")}`;
    } catch (err) {
      console.error(`[GROUP MAP CLEAR FAIL] code=${command.code} groupId=${groupId}`, err?.response?.data || err?.message || err);
      replyText += `\n⚠️ 등록은 완료됐지만 기존 매핑 자동 해제는 실패했습니다. LINE그룹매핑 시트에서 ${clearedCodes.join(", ")} 행을 확인해주세요.`;
    }
  }

  return replyText;
}

async function findMappedGroupId(accessToken, codeToFind) {
  const targetCode = String(codeToFind || "").trim().toUpperCase();
  const values = await getGroupMapValues(accessToken);

  // 같은 코드가 시트에 여러 번 남아 있으면 아래쪽(최근 등록)을 우선 사용한다.
  // PP01방에 버튼이 안 들어오는 대부분의 원인이 예전 PP01 매핑행을 먼저 잡는 문제라서,
  // 관리자 확인방도 최신 groupId 기준으로 찾도록 한다.
  for (let i = values.length - 1; i >= 1; i -= 1) {
    const code = String(values[i]?.[0] || "").trim().toUpperCase();
    const groupId = String(values[i]?.[1] || "").trim();
    if (code === targetCode && groupId) return groupId;
  }
  return null;
}

async function findMappedCodeByGroupId(accessToken, sourceGroupId) {
  const groupId = String(sourceGroupId || "").trim();
  if (!groupId) return null;

  const values = await getGroupMapValues(accessToken);
  // 같은 그룹이 여러 번 매핑되어 있으면 시트 아래쪽(최근 등록)을 우선 사용한다.
  for (let i = values.length - 1; i >= 1; i -= 1) {
    const code = String(values[i]?.[0] || "").trim().toUpperCase();
    const mappedGroupId = String(values[i]?.[1] || "").trim();
    if (code && mappedGroupId === groupId) return code;
  }
  return null;
}

function getLineSourceGroupId(event) {
  return event?.source?.groupId || event?.source?.roomId || "";
}

async function downloadLineMessageContent(messageId) {
  const response = await axios.get(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    responseType: "arraybuffer",
    headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }
  });

  const contentType = response.headers?.["content-type"] || "image/jpeg";
  const buffer = Buffer.from(response.data);
  const base64 = buffer.toString("base64");
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  return { contentType, base64, sha256 };
}

function parseJsonObjectLoose(text) {
  const raw = String(text || "").trim();
  try {
    return JSON.parse(raw);
  } catch (_) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch (_) {
      return null;
    }
  }
}

function normalizeWonAmount(value) {
  if (value === null || value === undefined) return null;
  const n = Number(String(value).replace(/[^0-9.-]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

function convertWonToSheetInputValue(wonAmount) {
  const n = normalizeWonAmount(wonAmount);
  if (!n) return null;
  const value = n / 10000;
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2))).replace(/\.0+$/, "");
}

function formatWon(amount) {
  const n = normalizeWonAmount(amount);
  return n ? `${n.toLocaleString("ko-KR")}원` : "△ 금액 확인 불가";
}

function normalizeAccountNumber(value) {
  const digits = String(value ?? "").replace(/[^0-9]/g, "");
  return digits || null;
}

function normalizeSenderName(value) {
  const clean = String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[^A-Za-z0-9가-힣ㄱ-ㅎㅏ-ㅣ ._-]/g, "");
  return clean || null;
}

function formatOptionalReceiptField(value, fallback = "△ 확인 불가") {
  const clean = String(value ?? "").trim();
  return clean || fallback;
}

function maskAccountNumber(value) {
  const digits = normalizeAccountNumber(value);
  if (!digits) return "△ 확인 불가";
  if (digits.length <= 6) return digits;
  return `${digits.slice(0, 3)}-${digits.slice(3, -3)}-${digits.slice(-3)}`;
}

function buildReceiptMatchText({ senderName, accountNumber }) {
  const expectedName = normalizeSenderName(RECEIPT_EXPECTED_SENDER_NAME);
  const expectedAccount = normalizeAccountNumber(RECEIPT_EXPECTED_ACCOUNT_NUMBER);
  const actualName = normalizeSenderName(senderName);
  const actualAccount = normalizeAccountNumber(accountNumber);

  const nameStatus = actualName
    ? (expectedName && actualName.toUpperCase() === expectedName.toUpperCase() ? "✅ 일치" : "❌ 불일치")
    : "△ 확인 불가";
  const accountStatus = actualAccount
    ? (expectedAccount && actualAccount === expectedAccount ? "✅ 일치" : "❌ 불일치")
    : "△ 확인 불가";

  return `입금자명 확인 : ${nameStatus}\n계좌번호 확인 : ${accountStatus}`;
}

function normalizeReceiptNameForCompare(value) {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9가-힣]/g, "");
}

function isExpectedReceiptSender(senderName) {
  const expectedName = normalizeReceiptNameForCompare(RECEIPT_EXPECTED_SENDER_NAME);
  const actualName = normalizeReceiptNameForCompare(senderName);
  if (!expectedName || !actualName) return true;

  // 모니터를 다시 찍은 사진/흐림/반사 때문에 예금주명이 일부만 읽히는 경우 보정.
  // 예: CHAYAPONE, MR CHAYAPONE, CHAYAPON, CHAYAP0NE 등 일부 OCR 흔들림 허용.
  if (actualName === expectedName) return true;
  if (actualName.includes(expectedName) || expectedName.includes(actualName)) return true;

  const compactExpected = expectedName.replace(/0/g, "O").replace(/1/g, "I");
  const compactActual = actualName.replace(/0/g, "O").replace(/1/g, "I");
  if (compactActual === compactExpected) return true;
  if (compactActual.includes(compactExpected) || compactExpected.includes(compactActual)) return true;

  // 앞 6글자 이상이 일치하면 CHAYAPONE 계열로 인정.
  const minLen = Math.min(compactExpected.length, compactActual.length);
  let samePrefix = 0;
  for (let i = 0; i < minLen; i += 1) {
    if (compactExpected[i] !== compactActual[i]) break;
    samePrefix += 1;
  }
  return samePrefix >= 6;
}

function normalizeTransferDate(value) {
  if (value == null) return "";
  let text = String(value).trim();
  if (!text || /^null$/i.test(text) || /확인\s*불가|미표기|없음/i.test(text)) return "";
  text = text.replace(/년|\//g, ".").replace(/월/g, ".").replace(/일/g, "").replace(/\s+/g, " ").trim();
  const m = text.match(/(20\d{2}|\d{2})[.\-]\s*(\d{1,2})[.\-]\s*(\d{1,2})(?:\s+(\d{1,2})[:시]\s*(\d{1,2})?)?/);
  if (!m) return text.slice(0, 40);
  let year = m[1];
  if (year.length === 2) year = `20${year}`;
  const month = String(Number(m[2])).padStart(2, "0");
  const day = String(Number(m[3])).padStart(2, "0");
  const hour = m[4] != null ? String(Number(m[4])).padStart(2, "0") : "";
  const minute = m[5] != null ? String(Number(m[5])).padStart(2, "0") : "";
  return hour ? `${year}-${month}-${day} ${hour}:${minute || "00"}` : `${year}-${month}-${day}`;
}

function formatTransferDate(value) {
  const normalized = normalizeTransferDate(value);
  return normalized || "△ 확인 불가";
}

function normalizeReceiptKeyPart(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, "")
    .toUpperCase();
}

function buildReceiptInfoKey({ code, amountWon, senderName, accountNumber, transferDate }) {
  const amount = normalizeWonAmount(amountWon) || "";
  const sender = normalizeReceiptKeyPart(normalizeSenderName(senderName));
  const account = normalizeAccountNumber(accountNumber) || "";
  const date = normalizeReceiptKeyPart(normalizeTransferDate(transferDate));
  const parts = [String(code || "").toUpperCase(), amount, sender, account, date].filter(Boolean);
  return crypto.createHash("sha256").update(parts.join("|"), "utf8").digest("hex");
}

function buildReceiptImageKey({ sourceGroupId, imageHash }) {
  if (!imageHash) return "";
  return crypto.createHash("sha256").update(`${sourceGroupId || ""}|${imageHash}`, "utf8").digest("hex");
}

function buildReceiptNearDuplicateKey({ sourceGroupId, code, amountWon, senderName, accountNumber }) {
  const amount = normalizeWonAmount(amountWon) || "";
  if (!sourceGroupId || !code || !amount) return "";

  const expectedSender = normalizeSenderName(RECEIPT_EXPECTED_SENDER_NAME);
  const expectedAccount = normalizeAccountNumber(RECEIPT_EXPECTED_ACCOUNT_NUMBER);
  const actualSender = normalizeSenderName(senderName);
  const actualAccount = normalizeAccountNumber(accountNumber);

  const senderMatched = expectedSender && actualSender && actualSender.toUpperCase() === expectedSender.toUpperCase();
  const accountMatched = expectedAccount && actualAccount && (
    actualAccount.includes(expectedAccount) || expectedAccount.includes(actualAccount)
  );

  // 기대 수취인/계좌로 확인되는 입금사진이면, 같은 그룹/코드/금액만 같아도
  // 같은 송금내역을 위/아래로 나눠 보낸 것으로 보고 버튼 중복 생성을 막는다.
  const matchPart = senderMatched || accountMatched ? "expected" : `${actualSender || ""}|${actualAccount || ""}`;
  return crypto.createHash("sha256").update(`${sourceGroupId}|${String(code).toUpperCase()}|${amount}|${matchPart}`, "utf8").digest("hex");
}

function buildReceiptDuplicateText(item) {
  if (item?.status === "confirmed") return "⚠️ 이미 등록 완료된 동일한 이체사진/이체내역입니다.";
  if (item?.status === "processing") return "⚠️ 이미 등록 처리 중인 동일한 이체사진/이체내역입니다.";
  if (item?.status === "cancelled") return "⚠️ 이미 취소 처리된 동일한 이체사진/이체내역입니다.";
  return "⚠️ 이미 분석된 동일한 이체사진/이체내역입니다. 기존 등록/취소 버튼을 사용해주세요.";
}

function buildReceiptAnalysisText({ code, amountWon, sheetValue, senderName, accountNumber, transferDate, includePrompt = true }) {
  const matchText = buildReceiptMatchText({ senderName, accountNumber });
  const promptText = includePrompt ? "\n\n💛 등록하시겠습니까?" : "";
  return `💛이체사진 분석완료\n\n고객코드 : ${code}\n이체날짜 : ${formatTransferDate(transferDate)}\n입금금액 : ${formatWon(amountWon)}\n입력값 : ${sheetValue}\n입금자명 : ${formatOptionalReceiptField(senderName)}\n계좌번호 : ${maskAccountNumber(accountNumber)}\n\n${matchText}${promptText}`;
}

function buildTextMessage(text, quickReply) {
  return {
    type: "text",
    text,
    ...(quickReply ? { quickReply } : {})
  };
}

async function callReceiptOcrOpenAI(image, retry = false) {
  const systemPrompt = retry
    ? "너는 한국 은행/간편송금 이체 캡처 이미지 재검토 OCR 분석기다. 1차 분석에서 등록 버튼을 만들지 못한 이미지를 다시 확인한다. 이미지는 모니터/ATM/휴대폰 화면을 다시 촬영한 사진일 수 있고, 반사광/유리빛/기울어짐/부분 가림/흐림/흔들림이 있거나, 화면이 가로/세로/90도/180도/270도 회전되어 있을 수 있으므로 반드시 가능한 모든 방향으로 돌려 읽는다고 가정한다. 실제 은행/금융앱/간편송금 앱의 이체 완료, 송금 완료, 입금 완료, 거래 영수증, 거래 확인 화면인지 먼저 판별한다. 단, 금액이 보인다고 해서 안내 포스터, 광고, 이벤트, 연체/벌금/납부 안내, 채팅 캡처, 일반 스크린샷이면 is_transfer_receipt=false로 둔다. 실제 금융앱 거래 화면으로 보이고 송금 금액이 사람 눈으로 읽히면 confidence를 과도하게 낮추지 마라. 금액은 KRW 55,000 / KRW55,000 / 55,000 KRW / ₩55,000 / 55000 / 55.000처럼 붙거나 줄이 나뉘거나 구분자가 달라도 같은 금액으로 인식한다. 수수료 KRW 0, 잔액, 한도, 벌금, 연체료, 날짜 숫자는 입금액으로 선택하지 마라. 계좌번호에 하이픈/공백이 있어도 숫자만 기준으로 읽는다. 수취인/예금주명/계좌번호 중 하나라도 기대값과 강하게 일치하고 금액이 확실하면, 화면 일부가 가려져도 등록 가능한 이체사진으로 판단한다. 특히 계좌번호 110551366954 또는 CHAYAPONE 계열 이름이 보이면 receipt_score와 confidence를 과도하게 낮추지 마라. 한 이미지 안에 같은 송금내역의 상단/하단 화면이 나란히 붙어 있거나, 같은 송금내역이 여러 장 캡처로 보이더라도 하나의 이체로만 판단하고 가장 명확한 송금금액 1개만 amount_won에 넣는다. 반드시 JSON만 출력한다."
    : "너는 한국 은행/간편송금 이체 캡처 이미지 판별 및 OCR 분석기다. 이미지는 모니터/ATM/휴대폰 화면을 다시 촬영한 사진일 수 있고, 반사광/유리빛/기울어짐/부분 가림/흐림/흔들림이 있거나, 세로/가로/90도/180도/270도 회전 상태일 수 있으므로 반드시 가능한 모든 방향으로 돌려 읽는다고 가정하고 분석한다. 가장 먼저 이미지가 실제 은행/금융앱/간편송금 앱의 이체 완료, 송금 완료, 입금 완료, 거래 영수증, 거래 확인 화면인지 엄격하게 판별한다. 금액 숫자가 있어도 안내 포스터, 광고 이미지, 이벤트 배너, 연체/벌금/납부 안내 이미지, 채팅 캡처, 일반 스크린샷, 인물/풍경/상품/문서 사진이면 반드시 is_transfer_receipt=false, receipt_score는 낮게 둔다. 실제 금융앱 거래 완료/확인 화면이라는 증거가 강할 때만 is_transfer_receipt=true로 둔다. 이체 캡처라면 실제 이체/송금/입금 금액, 이체 날짜/시간, 화면에 표시된 상대방 이름(입금자명/받는분명/수취인명/예금주명), 계좌번호를 각각 독립적으로 추출한다. KRW 55,000 / KRW55,000 / 55,000 KRW / ₩55,000 / 55000 처럼 붙어있거나 줄이 나뉜 금액도 같은 금액으로 인식한다. 수수료 KRW 0, 잔액, 한도, 벌금, 연체료, 날짜 숫자는 입금액으로 선택하지 마라. 계좌번호에 하이픈이나 공백이 있어도 숫자만 기준으로 읽는다. 흐리거나 화면에 없는 값은 null로 둔다. 금액이 사람 눈으로 충분히 읽히거나 계좌번호 110551366954 또는 CHAYAPONE 계열 이름이 보이면 confidence를 과도하게 낮추지 마라. 한 이미지 안에 같은 송금내역의 상단/하단 화면이 나란히 붙어 있거나, 같은 송금내역이 여러 장 캡처로 보이더라도 하나의 이체로만 판단하고 가장 명확한 송금금액 1개만 amount_won에 넣는다. 반드시 JSON만 출력한다.";

  const userPrompt = retry
    ? "같은 이미지를 한 번 더 재검토해줘. 1차에서 애매했더라도 실제 은행/간편송금 이체 완료 화면으로 보이고 실제 송금 금액이 읽히면 등록 버튼을 만들 수 있게 값을 추출해줘. 단, 일반 사진/공지/광고/연체 안내/채팅 캡처는 절대 통과시키지 마라. amount_won은 실제 송금/입금 금액만 넣고, 수수료/잔액/한도/날짜/연체료는 제외해줘. JSON 형식: {\"is_transfer_receipt\":true,\"amount_won\":60000,\"transfer_date\":\"2026-06-26 18:30\",\"sender_name\":\"CHAYAPONE\",\"account_number\":\"110551366954\",\"confidence\":0.82,\"receipt_score\":85,\"reason\":\"재검토 근거\"}"
    : "이 이미지가 은행/간편송금 이체 캡처인지 먼저 판별하고, 맞을 때만 4가지를 분석해줘. 1) 실제 이체/송금/입금 금액 amount_won, 2) 이체 날짜/시간 transfer_date, 3) 화면에 표시된 상대방 이름(입금자명/받는분명/수취인명/예금주명) sender_name, 4) 계좌번호 account_number. 계좌번호는 하이픈이 있어도 숫자만 account_number에 넣어줘. 날짜는 가능하면 YYYY-MM-DD HH:mm 형식으로 넣어줘. 확실하지 않거나 화면에 없으면 null. 일반 사진이나 이체와 관련 없는 이미지면 is_transfer_receipt=false, amount_won/transfer_date/sender_name/account_number=null로 반환해줘. JSON 형식: {\"is_transfer_receipt\":true,\"amount_won\":60000,\"transfer_date\":\"2026-06-26 18:30\",\"sender_name\":\"CHAYAPONE\",\"account_number\":\"110551366954\",\"confidence\":0.95,\"reason\":\"짧은 근거\"}";

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: RECEIPT_OCR_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "text", text: userPrompt },
            {
              type: "image_url",
              image_url: { url: `data:${image.contentType};base64,${image.base64}` }
            }
          ]
        }
      ],
      max_completion_tokens: 300
    })
  });

  const data = await response.json();
  if (!response.ok) {
    console.error("[RECEIPT OCR OPENAI FAIL]", data);
    return { ok: false, error: "⚠️ 이체사진 분석 중 오류가 발생했습니다." };
  }

  const content = data?.choices?.[0]?.message?.content || "";
  const parsed = parseJsonObjectLoose(content);
  const isTransferReceipt = parsed?.is_transfer_receipt === true || parsed?.is_transfer_receipt === "true";
  const amountWon = normalizeWonAmount(parsed?.amount_won);
  const senderName = normalizeSenderName(parsed?.sender_name);
  const accountNumber = normalizeAccountNumber(parsed?.account_number);
  const transferDate = normalizeTransferDate(parsed?.transfer_date);
  const confidence = Number(parsed?.confidence ?? 0);
  const rawReceiptScore = Number(parsed?.receipt_score ?? NaN);
  const receiptScore = Number.isFinite(rawReceiptScore)
    ? rawReceiptScore
    : (Number.isFinite(confidence) ? confidence * 100 : 0);

  const expectedAccountMatched = accountNumber && RECEIPT_EXPECTED_ACCOUNT_NUMBER
    ? accountNumber.includes(RECEIPT_EXPECTED_ACCOUNT_NUMBER) || RECEIPT_EXPECTED_ACCOUNT_NUMBER.includes(accountNumber)
    : false;
  const expectedSenderMatched = isExpectedReceiptSender(senderName);
  const hasExpectedReceiptClue = Boolean(expectedAccountMatched || expectedSenderMatched);

  // 모니터 재촬영/반사/기울어짐 사진은 OCR 점수가 낮게 나올 수 있으므로
  // 실제 이체화면으로 판단되고 기대 계좌/예금주 단서가 있으면 점수 기준을 보정한다.
  if (!isTransferReceipt || !Number.isFinite(receiptScore) || (receiptScore < RECEIPT_MIN_RECEIPT_SCORE && !hasExpectedReceiptClue)) {
    return { ok: false, ignored: true, reason: retry ? "retry_not_receipt" : "not_receipt" };
  }

  if (RECEIPT_REQUIRE_EXPECTED_SENDER && senderName && !expectedSenderMatched && !expectedAccountMatched) {
    return { ok: false, ignored: true, reason: "unexpected_sender" };
  }

  const hasStrongReceiptClue = Boolean(senderName || accountNumber || transferDate);
  const effectiveConfidence = Number.isFinite(confidence) ? confidence : 0;
  const retryPassByClue = retry && amountWon && (expectedAccountMatched || expectedSenderMatched || accountNumber || senderName);

  if (!amountWon || (effectiveConfidence < RECEIPT_MIN_CONFIDENCE && !hasStrongReceiptClue && !retryPassByClue)) {
    return { ok: false, error: "⚠️ 이체금액을 확실하게 확인하지 못했습니다. 직접 코드/금액으로 등록해주세요.", reason: retry ? "retry_amount_unclear" : "amount_unclear" };
  }

  const sheetValue = convertWonToSheetInputValue(amountWon);
  if (!sheetValue) {
    return { ok: false, error: "⚠️ 이체금액 변환에 실패했습니다. 직접 코드/금액으로 등록해주세요.", reason: "convert_failed" };
  }

  return {
    ok: true,
    amountWon,
    sheetValue,
    senderName,
    accountNumber,
    transferDate,
    confidence,
    receiptScore,
    receiptKind: String(parsed?.receipt_kind || "").slice(0, 80),
    reason: String(parsed?.reason || "").slice(0, 80),
    imageHash: image.sha256,
    retried: retry
  };
}

async function analyzeReceiptImageAmount(messageId) {
  if (!process.env.OPENAI_API_KEY) {
    return { ok: false, error: "⚠️ OPENAI_API_KEY 환경변수가 설정되지 않았습니다." };
  }

  const image = await downloadLineMessageContent(messageId);

  let result = await callReceiptOcrOpenAI(image, false);

  // 1차 분석에서 등록 버튼을 만들지 못하면 같은 이미지를 한 번 더 재검토한다.
  // 흐릿함/회전/금액 표기 분리/KRW 표기 문제로 1차가 흔들리는 경우 등록 버튼 누락을 줄이기 위한 처리.
  if (!result.ok) {
    console.log(`[RECEIPT OCR RETRY] messageId=${messageId} reason=${result.reason || result.error || "unknown"}`);
    const retryResult = await callReceiptOcrOpenAI(image, true);
    if (retryResult.ok) {
      result = retryResult;
    } else if (!result.error && retryResult.error) {
      result = retryResult;
    }
  }

  return result;
}

function buildReceiptConfirmMessages({ code, amountWon, sheetValue, senderName, accountNumber, transferDate, receiptKey, sourceGroupId, pendingId, approvalNotice = false }) {
  // LINE postback data는 길이 제한이 있어 입금자/계좌/날짜 같은 표시용 값은 버튼 data에서 제외한다.
  // 특히 PP01방에서 누를 때 원본 고객방 sourceGroupId가 잘리지 않도록 필수값만 담는다.
  const dataBase = `receipt=1&pid=${encodeURIComponent(pendingId || "")}&key=${encodeURIComponent(receiptKey || "")}&code=${encodeURIComponent(code)}&value=${encodeURIComponent(sheetValue)}&won=${encodeURIComponent(amountWon)}&source=${encodeURIComponent(sourceGroupId || "")}`;
  const analysisText = buildReceiptAnalysisText({
    code,
    amountWon,
    sheetValue,
    senderName,
    accountNumber,
    transferDate,
    includePrompt: false
  });

  return [
    buildTextMessage(approvalNotice ? `📥 ${RECEIPT_APPROVAL_GROUP_CODE} 등록 대기

${analysisText}` : analysisText),
    {
      type: "template",
      altText: "💛 등록하시겠습니까?",
      template: {
        type: "buttons",
        text: "💛 등록하시겠습니까?",
        actions: [
          {
            type: "postback",
            label: "등록",
            data: `${dataBase}&action=confirm`,
            displayText: "등록"
          },
          {
            type: "postback",
            label: "취소",
            data: `${dataBase}&action=cancel`,
            displayText: "취소"
          }
        ]
      }
    }
  ];
}

function parseReceiptPostback(event) {
  const data = String(event?.postback?.data || "");
  const params = new URLSearchParams(data);
  if (params.get("receipt") !== "1") return null;

  const pendingId = String(params.get("pid") || "").trim();
  const receiptKey = String(params.get("key") || "").trim();
  const code = String(params.get("code") || "").trim().toUpperCase();
  const value = String(params.get("value") || "").trim();
  const won = normalizeWonAmount(params.get("won"));
  const senderName = normalizeSenderName(params.get("sender"));
  const accountNumber = normalizeAccountNumber(params.get("account"));
  const transferDate = normalizeTransferDate(params.get("date"));
  const sourceGroupId = String(params.get("source") || "").trim();
  const action = String(params.get("action") || "").trim();

  if (!code || !value || !won || !["confirm", "cancel"].includes(action)) return null;
  return { action, pendingId, receiptKey, code, value, won, senderName, accountNumber, transferDate, sourceGroupId };
}

async function getReceiptApprovalGroupId(accessToken) {
  if (RECEIPT_APPROVAL_GROUP_ID) return RECEIPT_APPROVAL_GROUP_ID;
  if (!RECEIPT_APPROVAL_GROUP_CODE) return null;
  return await findMappedGroupId(accessToken, RECEIPT_APPROVAL_GROUP_CODE);
}

function getReceiptDoneText(receipt) {
  return `✅ ${receipt.code}/${receipt.value}
등록 완료되었습니다.

(${getKoreaDateTimeText()})`;
}

async function pushReceiptDoneToRelatedGroups({ clickedGroupId, sourceGroupId, approvalGroupId, text }) {
  const targets = new Set([sourceGroupId, approvalGroupId].filter(Boolean));
  if (clickedGroupId) targets.delete(clickedGroupId);

  const failures = [];
  for (const targetGroupId of targets) {
    try {
      await pushToLine(targetGroupId, text);
    } catch (err) {
      const errorText = getLinePushErrorMessage(err);
      failures.push(`${targetGroupId}: ${errorText}`);
      console.error(`[RECEIPT DONE PUSH FAIL] targetGroupId=${targetGroupId} error=${errorText}`);
    }
  }
  return failures;
}


async function notifyReceiptAnalysisFailureToApprovalGroup({ accessToken, sourceGroupId, code, messageId, error }) {
  try {
    const approvalGroupId = await getReceiptApprovalGroupId(accessToken);
    if (!approvalGroupId || approvalGroupId === sourceGroupId) {
      console.warn(`[RECEIPT OCR FAIL NOTICE SKIP] approvalGroupId=${approvalGroupId || "not_found"} sourceGroupId=${sourceGroupId}`);
      return;
    }

    const safeError = String(error || "분석 결과를 확정하지 못했습니다.").slice(0, 500);
    const noticeText = [
      "⚠️ 이체사진 분석 실패",
      "",
      `고객방 코드: ${code || "-"}`,
      `고객방 ID: ${sourceGroupId || "-"}`,
      `메시지 ID: ${messageId || "-"}`,
      `사유: ${safeError}`,
      "",
      "1차 분석 후 재분석까지 실패해서 등록 버튼을 만들지 못했습니다.",
      "고객방의 원본 이미지를 직접 확인해주세요.",
      "",
      `(${getKoreaDateTimeText()})`
    ].join("\n");

    await pushToLine(approvalGroupId, noticeText);
  } catch (err) {
    const errorText = getLinePushErrorMessage(err);
    console.error(`[RECEIPT OCR FAIL NOTICE PUSH FAIL] code=${code || "-"} sourceGroupId=${sourceGroupId || "-"} error=${errorText}`);
  }
}

async function handleReceiptImageMessage(event) {
  const sourceGroupId = getLineSourceGroupId(event);
  if (!sourceGroupId) return;
  if (!SHEET_ID) {
    await replyToLine(event.replyToken, "⚠️ GOOGLE_SHEET_ID 환경변수가 설정되지 않았습니다.");
    return;
  }

  const accessToken = await getGoogleAccessToken();
  const code = await findMappedCodeByGroupId(accessToken, sourceGroupId);
  if (!code) {
    // 코드/등록이 되지 않은 그룹방에서는 아무 반응하지 않는다.
    return;
  }

  const result = await analyzeReceiptImageAmount(event.message.id);
  if (!result.ok) {
    if (result.ignored) return;
    await notifyReceiptAnalysisFailureToApprovalGroup({
      accessToken,
      sourceGroupId,
      code,
      messageId: event.message.id,
      error: result.error || result.reason
    });
    await replyToLine(event.replyToken, result.error || "⚠️ 이체사진 분석에 실패했습니다. 이미지를 다시 올려주세요.");
    return;
  }

  const imageKey = buildReceiptImageKey({ sourceGroupId, imageHash: result.imageHash });
  const infoKey = buildReceiptInfoKey({
    code,
    amountWon: result.amountWon,
    senderName: result.senderName,
    accountNumber: result.accountNumber,
    transferDate: result.transferDate
  });

  const nearDuplicateKey = buildReceiptNearDuplicateKey({
    sourceGroupId,
    code,
    amountWon: result.amountWon,
    senderName: result.senderName,
    accountNumber: result.accountNumber
  });

  const existing = receiptCacheGet(imageKey) || receiptCacheGet(infoKey) || receiptCacheGet(nearDuplicateKey);
  if (existing) {
    // 같은 송금내역을 스크롤해서 위/아래 2장으로 보낸 경우에는
    // 등록 버튼을 다시 만들지 않고 기존 버튼만 사용하게 한다.
    await replyToLine(event.replyToken, buildReceiptDuplicateText(existing));
    return;
  }

  const receiptKey = infoKey || imageKey || nearDuplicateKey;
  const pendingId = makeReceiptPendingId(receiptKey, sourceGroupId);
  const accessGroupToken = accessToken;
  const approvalGroupId = await getReceiptApprovalGroupId(accessGroupToken);

  const cacheItem = {
    status: "pending",
    pendingId,
    imageKey,
    infoKey,
    nearDuplicateKey,
    sourceGroupId,
    approvalGroupId,
    code,
    amountWon: result.amountWon,
    sheetValue: result.sheetValue,
    senderName: result.senderName,
    accountNumber: result.accountNumber,
    transferDate: result.transferDate
  };
  receiptCacheSet(imageKey, cacheItem);
  receiptCacheSet(infoKey, cacheItem);
  receiptCacheSet(nearDuplicateKey, cacheItem, RECEIPT_NEAR_DUPLICATE_TTL_MS);
  receiptCacheSet(pendingId, cacheItem);
  try {
    await appendReceiptPending(accessToken, cacheItem);
  } catch (err) {
    console.error(`[RECEIPT PENDING APPEND FAIL] pendingId=${pendingId} error=${err?.response?.data?.error?.message || err?.message || err}`);
  }

  const confirmMessages = buildReceiptConfirmMessages({
    code,
    amountWon: result.amountWon,
    sheetValue: result.sheetValue,
    senderName: result.senderName,
    accountNumber: result.accountNumber,
    transferDate: result.transferDate,
    receiptKey,
    sourceGroupId,
    pendingId
  });

  // 고객방에 등록 버튼이 생성되면 PP01 관리자 확인방에도 같은 버튼을 함께 보낸다.
  // PP01방에서 등록을 눌러도 같은 receiptKey를 처리하므로 고객방과 동일하게 등록된다.
  let approvalPushError = "";
  if (approvalGroupId && approvalGroupId !== sourceGroupId) {
    const approvalMessages = buildReceiptConfirmMessages({
      code,
      amountWon: result.amountWon,
      sheetValue: result.sheetValue,
      senderName: result.senderName,
      accountNumber: result.accountNumber,
      transferDate: result.transferDate,
      receiptKey,
      sourceGroupId,
      pendingId,
      approvalNotice: true
    });
    try {
      await pushToLineMessages(approvalGroupId, approvalMessages);
    } catch (err) {
      approvalPushError = getLinePushErrorMessage(err);
      console.error(`[RECEIPT APPROVAL PUSH FAIL] code=${code} approvalGroupId=${approvalGroupId} error=${approvalPushError}`);
    }
  }

  // 관리자방 동시 푸시 실패는 고객방에 노출하지 않고 서버 로그에만 남긴다.
  // LINE 월 한도(429)처럼 고객에게 보여줄 필요 없는 오류가 고객방에 뜨지 않도록 한다.
  if (!approvalGroupId) {
    console.warn(`[RECEIPT APPROVAL PUSH SKIP] ${RECEIPT_APPROVAL_GROUP_CODE} approval groupId not found`);
  } else if (approvalPushError) {
    console.warn(`[RECEIPT APPROVAL PUSH ERROR HIDDEN] ${RECEIPT_APPROVAL_GROUP_CODE} error=${approvalPushError}`);
  }

  await replyToLineMessages(event.replyToken, confirmMessages);
}

async function handleReceiptPostback(event, receipt) {
  const accessToken = await getGoogleAccessToken();
  let cached = receiptCacheGet(receipt.pendingId) || receiptCacheGet(receipt.receiptKey);
  let pending = null;
  if (receipt.pendingId) {
    try {
      pending = await findReceiptPending(accessToken, receipt.pendingId);
      if (pending) cached = { ...(cached || {}), ...pending };
    } catch (err) {
      console.error(`[RECEIPT PENDING READ FAIL] pendingId=${receipt.pendingId} error=${err?.response?.data?.error?.message || err?.message || err}`);
    }
  }

  const fallbackApprovalGroupId = cached?.approvalGroupId || pending?.approvalGroupId || await getReceiptApprovalGroupId(accessToken);
  if (!canApproveReceipt(event, { ...receipt, approvalGroupId: fallbackApprovalGroupId }, cached, pending)) {
    await replyUnauthorized(event);
    return;
  }

  if (cached?.status === "confirmed") {
    await replyToLine(event.replyToken, "⚠️ 이미 등록 완료된 요청입니다.");
    return;
  }
  if (cached?.status === "processing") {
    await replyToLine(event.replyToken, "⚠️ 이미 등록 처리 중인 요청입니다.");
    return;
  }
  if (cached?.status === "cancelled") {
    await replyToLine(event.replyToken, "⚠️ 이미 취소 처리된 요청입니다.");
    return;
  }

  const setReceiptStatus = async status => {
    if (cached) {
      receiptCacheSet(cached.imageKey, { ...cached, status });
      receiptCacheSet(cached.infoKey, { ...cached, status });
      receiptCacheSet(cached.nearDuplicateKey, { ...cached, status });
      receiptCacheSet(cached.pendingId || receipt.pendingId, { ...cached, status });
    } else if (receipt.receiptKey) {
      receiptCacheSet(receipt.receiptKey, {
        pendingId: receipt.pendingId,
        status,
        sourceGroupId: receipt.sourceGroupId,
        code: receipt.code,
        amountWon: receipt.won,
        sheetValue: receipt.value
      });
    }
    if (pending) {
      try { await updateReceiptPendingStatus(accessToken, pending, status); } catch (err) { console.error(`[RECEIPT PENDING STATUS FAIL] pendingId=${receipt.pendingId} error=${err?.response?.data?.error?.message || err?.message || err}`); }
    }
  };

  if (receipt.action === "cancel") {
    await setReceiptStatus("cancelled");
    await replyToLine(event.replyToken, `취소되었습니다.
${receipt.code} / ${formatWon(receipt.won)} / 입력값 ${receipt.value}
입금자명 : ${formatOptionalReceiptField(receipt.senderName)}
계좌번호 : ${maskAccountNumber(receipt.accountNumber)}`);
    return;
  }

  // 고객방과 PP01방에 같은 버튼이 떠 있어도 시트 반영은 한 번만 실행되게
  // 먼저 processing 상태로 잠근 뒤 실제 시트 입력을 진행한다.
  await setReceiptStatus("processing");

  const replyText = await writeSheetCommand({ code: receipt.code, value: receipt.value });
  if (!String(replyText || "").startsWith("✅")) {
    await setReceiptStatus("pending");
    await replyToLine(event.replyToken, replyText);
    return;
  }

  await setReceiptStatus("confirmed");

  const clickedGroupId = getLineSourceGroupId(event);
  const doneText = getReceiptDoneText(receipt);
  const approvalGroupId = cached?.approvalGroupId || (SHEET_ID ? await getReceiptApprovalGroupId(accessToken) : null);
  const sourceGroupId = cached?.sourceGroupId || pending?.sourceGroupId || receipt.sourceGroupId;

  await replyToLine(event.replyToken, doneText);
  const pushFailures = await pushReceiptDoneToRelatedGroups({
    clickedGroupId,
    sourceGroupId,
    approvalGroupId,
    text: doneText
  });

  if (!sourceGroupId) {
    await replyToLine(event.replyToken, "⚠️ 등록은 완료됐지만 원본 고객방 ID를 찾지 못해 고객방 완료 알림을 보낼 수 없습니다. 최신 수정본으로 고객방에서 슬립을 다시 올린 뒤 PP01방 버튼을 눌러주세요.");
  } else if (pushFailures.length) {
    await replyToLine(event.replyToken, `⚠️ 등록은 완료됐지만 일부 방 완료 알림 발송에 실패했습니다.\n${pushFailures.join("\n")}`);
  }
}

async function pushToLine(to, text, retryKey = null) {
  const headers = {
    Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    "Content-Type": "application/json"
  };

  // 같은 push 요청이 네트워크 타임아웃 등으로 재시도될 때 LINE 쪽 중복 발송을 줄인다.
  if (retryKey) {
    headers["X-Line-Retry-Key"] = retryKey;
  }

  return axios.post(
    "https://api.line.me/v2/bot/message/push",
    {
      to,
      messages: [{ type: "text", text }]
    },
    { headers }
  );
}

async function pushToLineMessages(to, messages, retryKey = null) {
  const headers = {
    Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    "Content-Type": "application/json"
  };

  if (retryKey) {
    headers["X-Line-Retry-Key"] = retryKey;
  }

  return axios.post(
    "https://api.line.me/v2/bot/message/push",
    { to, messages },
    { headers }
  );
}

// 오늘상환오전/오후/요청 발송 속도 설정
// 기존에는 1건씩 순차 발송 + 건별 대기시간으로 느렸기 때문에,
// 기본값을 병렬 발송으로 변경한다.
// 필요 시 환경변수 LINE_PUSH_CONCURRENCY로 동시 발송 개수를 조절 가능.
const LINE_PUSH_CONCURRENCY = Math.max(1, Number(process.env.LINE_PUSH_CONCURRENCY || 10));
const LINE_PUSH_DELAY_MS = Number(process.env.LINE_PUSH_DELAY_MS || 0);
const LINE_PUSH_RETRY_COUNT = Number(process.env.LINE_PUSH_RETRY_COUNT || 0);
const LINE_PUSH_RETRY_DELAY_MS = Number(process.env.LINE_PUSH_RETRY_DELAY_MS || 500);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getLinePushErrorMessage(err) {
  const status = err?.response?.status;
  const message = err?.response?.data?.message || err?.message || "Unknown error";
  const details = err?.response?.data?.details;

  if (Array.isArray(details) && details.length) {
    const detailText = details
      .map(item => item?.message || JSON.stringify(item))
      .filter(Boolean)
      .join(" / ");
    return status ? `${status} ${message} - ${detailText}` : `${message} - ${detailText}`;
  }

  return status ? `${status} ${message}` : message;
}

async function pushToLineWithRetry(code, groupId, text) {
  let lastError = null;
  const retryKey = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : crypto.createHash("sha256").update(`${Date.now()}:${code}:${groupId}:${text}`).digest("hex").slice(0, 36);

  for (let attempt = 1; attempt <= LINE_PUSH_RETRY_COUNT + 1; attempt += 1) {
    try {
      await pushToLine(groupId, text, retryKey);
      return { ok: true, attempt };
    } catch (err) {
      lastError = err;
      const errorMessage = getLinePushErrorMessage(err);
      console.error(`[LINE PUSH FAIL] code=${code} groupId=${groupId} attempt=${attempt}/${LINE_PUSH_RETRY_COUNT + 1} error=${errorMessage}`);

      if (attempt <= LINE_PUSH_RETRY_COUNT) {
        await sleep(LINE_PUSH_RETRY_DELAY_MS);
      }
    }
  }

  return {
    ok: false,
    attempt: LINE_PUSH_RETRY_COUNT + 1,
    error: getLinePushErrorMessage(lastError)
  };
}

function parseTodayRepaymentBroadcastCommand(text) {
  const clean = normalizeText(text).replace(/\s+/g, "");

  if (clean === "오늘상환요청") {
    return { type: "payment", message: PAYMENT_REQUEST_MESSAGE };
  }

  if (clean === "오늘상환오전") {
    return { type: "morning", message: REPAYMENT_MORNING_MESSAGE };
  }

  if (clean === "오늘상환오후") {
    return { type: "afternoon", message: REPAYMENT_AFTERNOON_MESSAGE };
  }

  return null;
}

function parseUnregisteredCheckCommand(text) {
  const clean = normalizeText(text).replace(/\s+/g, "");
  return clean === "미등록확인";
}

function parseMyIdCommand(text) {
  const clean = normalizeText(text).replace(/\s+/g, "");
  return clean === "내아이디" || clean === "관리자아이디확인";
}

function getLineUserId(event) {
  return event?.source?.userId || "";
}

function isAdmin(event) {
  const userId = getLineUserId(event);
  return ADMIN_USER_IDS.includes(userId);
}

function canManageCheckOver(event) {
  const userId = getLineUserId(event);
  const allowedIds = CHECKOVER_ADMIN_USER_IDS.length ? CHECKOVER_ADMIN_USER_IDS : ADMIN_USER_IDS;
  return allowedIds.includes(userId);
}

function canApproveReceipt(event, receipt = null, cached = null, pending = null) {
  const userId = getLineUserId(event);
  const approverIds = RECEIPT_APPROVER_USER_IDS.length ? RECEIPT_APPROVER_USER_IDS : ADMIN_USER_IDS;

  // 입금 슬립 등록/취소는 지정된 승인자만 가능하다.
  // PP01 승인방에서 누르더라도 userId가 승인자 목록에 없으면 처리하지 않는다.
  return approverIds.includes(userId);
}

async function replyUnauthorized(event) {
  await replyToLine(event.replyToken, "⛔ 권한이 없습니다.");
}

function extractCustomerCodeFromProductName(productName) {
  const match = String(productName || "").match(/([A-Za-z]{1,3}\d{1,3})/);
  return match ? match[1].toUpperCase() : null;
}

function normalizeCustomerNameCompact(name) {
  return normalizeText(name)
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function getCustomerNameSearchVariants(name) {
  const clean = normalizeText(name).toLowerCase();
  const tokens = clean.split(/\s+/).filter(Boolean);
  const variants = new Set();

  const compact = normalizeCustomerNameCompact(clean);
  if (compact) variants.add(compact);

  // 성/이름 또는 이름/성이 뒤바뀐 경우도 같은 고객으로 검색한다.
  if (tokens.length >= 2) {
    const reversedCompact = tokens.slice().reverse().join("").replace(/\s+/g, "");
    if (reversedCompact) variants.add(reversedCompact);
  }

  return variants;
}

function customerNameMatches(sheetName, inputName) {
  const sheetVariants = getCustomerNameSearchVariants(sheetName);
  const inputVariants = getCustomerNameSearchVariants(inputName);

  for (const variant of inputVariants) {
    if (sheetVariants.has(variant)) return true;
  }

  return false;
}

function levenshteinDistance(a, b) {
  const left = String(a || "");
  const right = String(b || "");

  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;

  const previous = Array(right.length + 1).fill(0).map((_, i) => i);
  const current = Array(right.length + 1).fill(0);

  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i;

    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost
      );
    }

    for (let j = 0; j <= right.length; j += 1) {
      previous[j] = current[j];
    }
  }

  return previous[right.length];
}

function getCustomerNameSimilarity(sheetName, inputName) {
  const sheetVariants = [...getCustomerNameSearchVariants(sheetName)];
  const inputVariants = [...getCustomerNameSearchVariants(inputName)];

  let best = 0;
  let bestDistance = Infinity;

  for (const sheetVariant of sheetVariants) {
    for (const inputVariant of inputVariants) {
      if (!sheetVariant || !inputVariant) continue;

      const distance = levenshteinDistance(sheetVariant, inputVariant);
      const maxLength = Math.max(sheetVariant.length, inputVariant.length, 1);
      const similarity = 1 - distance / maxLength;

      if (similarity > best || (similarity === best && distance < bestDistance)) {
        best = similarity;
        bestDistance = distance;
      }
    }
  }

  return { similarity: best, distance: bestDistance };
}

function findSimilarCustomerCandidates(values, inputName, limit = 5) {
  const candidateMap = new Map();

  for (let i = 1; i < values.length; i += 1) {
    const row = values[i] || [];
    if (!isPossibleCustomerTopRow(row)) continue;

    const record = getCreditRecordFromRows(values, i);
    if (!record.customerName) continue;

    const key = normalizeCustomerNameCompact(record.customerName);
    if (!key) continue;

    const scoreInfo = getCustomerNameSimilarity(record.customerName, inputName);
    const code = record.code || null;

    const previous = candidateMap.get(key);
    if (!previous) {
      candidateMap.set(key, {
        name: record.customerName,
        similarity: scoreInfo.similarity,
        distance: scoreInfo.distance,
        codes: code ? new Set([code]) : new Set(),
        count: 1
      });
      continue;
    }

    previous.similarity = Math.max(previous.similarity, scoreInfo.similarity);
    previous.distance = Math.min(previous.distance, scoreInfo.distance);
    previous.count += 1;
    if (code) previous.codes.add(code);
  }

  return [...candidateMap.values()]
    .filter(item => item.similarity >= 0.85 || item.distance <= 2)
    .sort((a, b) => {
      if (b.similarity !== a.similarity) return b.similarity - a.similarity;
      if (a.distance !== b.distance) return a.distance - b.distance;
      return b.count - a.count;
    })
    .slice(0, limit)
    .map(item => ({
      ...item,
      similarityPercent: Math.round(item.similarity * 100),
      codes: [...item.codes]
    }));
}

function buildSimilarCustomerReply(keyword, candidates) {
  if (!candidates.length) {
    return `⚠️ ${keyword} 조회 결과가 없습니다.\n\n이름은 공백/성·이름 순서를 자동 보정하지만, 철자 차이가 큰 경우 검색되지 않을 수 있습니다.`;
  }

  const lines = candidates.map((item, index) => {
    const codes = item.codes.length ? ` / 코드 ${item.codes.slice(0, 5).join(", ")}` : "";
    return `${index + 1}. ${item.name} (${item.similarityPercent}% 유사${codes})`;
  });

  return `⚠️ 정확히 일치하는 고객이 없습니다.\n\n의심 고객 후보\n${lines.join("\n")}\n\n후보가 맞다면 시트의 정확한 고객명 또는 코드로 다시 조회해주세요.`;
}

function parseCreditNumber(value) {
  const raw = String(value ?? "").trim();
  if (!raw || raw === "$" || raw === "-" || /^x$/i.test(raw)) return null;

  const cleaned = raw.replace(/,/g, "").replace(/[^0-9.\-]/g, "");
  if (!cleaned || cleaned === "-" || cleaned === ".") return null;

  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function parseCreditLoanDateInfo(monthValue, dayValue) {
  const yearMonth = parseYearMonthValue(monthValue); // B열 년/월
  const rawDay = String(dayValue ?? "").trim(); // H열 날짜
  if (!yearMonth || !rawDay) return null;

  const dayNums = rawDay.match(/\d+/g) || [];
  if (!dayNums.length) return null;

  const year = getFullYearFromYearMonth(yearMonth);
  const month = Number(String(yearMonth).slice(2, 4));
  const day = Number(dayNums[dayNums.length - 1]);

  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  return { year, month, day, value: year * 10000 + month * 100 + day };
}

function formatCreditLoanDate(monthValue, dayValue) {
  const info = parseCreditLoanDateInfo(monthValue, dayValue);
  if (!info) return "-";
  return `${info.year}-${pad2(info.month)}-${pad2(info.day)}`;
}

function getCreditRecordFromRows(values, topIndex0) {
  const topRow = values[topIndex0] || [];
  const bottomRow = values[topIndex0 + 1] || [];
  const status = String(topRow[2] || "").trim(); // C열
  const customerType = String(topRow[3] || "").trim(); // D열
  const productName = String(topRow[5] || "").trim(); // F열
  const customerName = String(topRow[6] || "").trim(); // G열
  const loanDateInfo = parseCreditLoanDateInfo(topRow[1], topRow[7]); // B열 년/월 + H열 날짜
  const loanDate = loanDateInfo ? `${loanDateInfo.year}-${pad2(loanDateInfo.month)}-${pad2(loanDateInfo.day)}` : "-";
  const principal = parseCreditNumber(topRow[8]); // I열
  const totalProfit = parseCreditNumber(topRow[9]); // J열: 총수익
  const bossProfit = parseCreditNumber(topRow[10]); // K열 상단: 보스수익
  const managerProfit = parseCreditNumber(bottomRow[10]); // K열 하단: 관리자수익
  const code = extractCustomerCodeFromProductName(productName);

  let xCount = 0;
  let dollarCount = 0;
  let paymentCount = 0;
  let paymentSum = 0;

  for (const row of [topRow, bottomRow]) {
    for (let c = DATE_START_COLUMN_INDEX; c <= DATE_END_COLUMN_INDEX; c += 1) {
      const raw = String(row[c] ?? "").trim();
      if (!raw) continue;
      if (/^x$/i.test(raw)) {
        xCount += 1;
        continue;
      }
      if (raw === "$") {
        dollarCount += 1;
        continue;
      }
      const amount = parseCreditNumber(raw);
      if (amount !== null) {
        paymentCount += 1;
        paymentSum += amount;
      }
    }
  }

  return {
    rowNumber: topIndex0 + 1,
    status,
    customerType,
    productName,
    customerName,
    loanDate,
    loanDateValue: loanDateInfo?.value || 0,
    principal,
    totalProfit,
    bossProfit,
    managerProfit,
    code,
    xCount,
    dollarCount,
    paymentCount,
    paymentSum
  };
}

function isPossibleCustomerTopRow(row) {
  const status = String(row?.[2] || "").trim();
  const productName = String(row?.[5] || "").trim();
  const customerName = String(row?.[6] || "").trim();
  return Boolean(customerName || extractCustomerCodeFromProductName(productName) || ["진행중", "종료", "블랙", "보류", "그룹"].includes(status));
}

function findCreditRecords(values, command) {
  const matches = [];
  const seenRows = new Set();

  // 고객 데이터는 2행 구조지만, 기존 양식 보존을 위해 모든 행을 확인한다.
  for (let i = 1; i < values.length; i += 1) {
    const row = values[i] || [];
    if (!isPossibleCustomerTopRow(row)) continue;

    const record = getCreditRecordFromRows(values, i);
    if (!record.customerName && !record.code) continue;

    let matched = false;
    if (command.type === "code") {
      matched = record.code === command.keyword;
    } else {
      matched = customerNameMatches(record.customerName, command.keyword);
    }

    if (matched && !seenRows.has(record.rowNumber)) {
      seenRows.add(record.rowNumber);
      matches.push(record);
    }
  }

  return matches.sort((a, b) => (a.loanDateValue || 0) - (b.loanDateValue || 0));
}

function clampScore(value, min, max) {
  const n = Math.max(0, Math.min(100, Math.round(value)));
  return Math.max(min, Math.min(max, n));
}

function calculateCreditScore(records) {
  const hasBlack = records.some(r => r.status === "블랙");
  const holdCount = records.filter(r => r.status === "보류").length;
  const closedCount = records.filter(r => r.status === "종료").length;
  const activeCount = records.filter(r => r.status === "진행중").length;
  const totalX = records.reduce((sum, r) => sum + r.xCount, 0);
  const avgX = records.length ? totalX / records.length : 0;
  const profitableClosedCount = records.filter(r =>
    r.status === "종료" && typeof r.totalProfit === "number" && r.totalProfit > 0
  ).length;

  // 최종 신용평가 기준
  // - 종료 이력이 없고 진행중만 있으며 X/보류/블랙이 없으면 N등급(평가대기)
  // - 정상종료 건수를 가장 강하게 반영한다.
  // - X는 총합이 아니라 거래당 평균 X로 감점한다.
  // - $는 아직 상환도래 전 표시이므로 점수/등급에 반영하지 않는다.
  // - 진행중 건수 자체는 감점하지 않는다.
  // - 보류가 있으면 최대 D등급, 블랙이 있으면 E등급 고정한다.
  if (!hasBlack && holdCount === 0 && closedCount === 0 && activeCount > 0 && totalX === 0) {
    return { score: null, grade: "N", decision: "평가 데이터 부족" };
  }

  let score = 60;

  // 정상종료 이력: 가장 중요한 가점 요소
  score += Math.min(closedCount * 8, 32);

  // 재거래 이력 보정
  if (records.length >= 3) score += 5;
  if (records.length >= 5) score += 5;

  // 종료된 거래 중 실제 수익이 난 건만 보조 가점
  score += Math.min(profitableClosedCount * 2, 10);

  // X는 오래 거래한 고객이 불리하지 않도록 거래당 평균으로 감점
  if (avgX > 10) score -= 40;
  else if (avgX > 6) score -= 25;
  else if (avgX > 3) score -= 12;
  else if (avgX > 1) score -= 5;

  if (holdCount > 0) score -= 20;

  score = Math.max(0, Math.min(100, Math.round(score)));

  if (hasBlack) {
    return { score: Math.min(score, 39), grade: "E", decision: "대출 불가" };
  }

  // 보류 고객은 점수가 높아도 최대 D등급으로 제한
  if (holdCount > 0) {
    return { score: Math.min(score, 59), grade: "D", decision: "주의 필요 / 한도 축소 권장" };
  }

  let grade = "E";
  if (score >= 90) grade = "A";
  else if (score >= 75) grade = "B";
  else if (score >= 60) grade = "C";
  else if (score >= 40) grade = "D";

  let decision = "대출 불가";
  if (grade === "A") decision = "재대출 가능";
  else if (grade === "B") decision = "재대출 가능 / 한도 유지 권장";
  else if (grade === "C") decision = "확인 후 진행";
  else if (grade === "D") decision = "주의 필요 / 한도 축소 권장";

  return { score, grade, decision };
}

function formatCreditProfitStatus(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "수익 -";
  const amount = formatAmountValue(value);
  if (value > 0) return `수익 +${amount}`;
  if (value < 0) return `손실 ${amount}`;
  return "수익 0";
}

function buildCreditReply(command, records) {
  if (!records.length) {
    return `⚠️ ${command.keyword} 조회 결과가 없습니다.\n\n이름은 공백/성·이름 순서를 자동 보정하지만, 철자 자체가 다르면 검색되지 않습니다.`;
  }

  const result = calculateCreditScore(records);
  const displayName = command.type === "name" ? command.keyword : (records[records.length - 1].customerName || command.keyword);
  const activeCount = records.filter(r => r.status === "진행중").length;

  const recentRecords = records
    .slice()
    .sort((a, b) => (b.loanDateValue || 0) - (a.loanDateValue || 0))
    .map(r => `${r.loanDate || "날짜없음"} / ${r.code || "코드없음"} / ${r.status || "상태없음"} / X ${r.xCount || 0}회 / ${formatCreditProfitStatus(r.totalProfit)}`)
    .join("\n");

  return `[고객 신용평가]\n\n` +
    `고객명: ${displayName}\n` +
    `등급: ${result.grade}\n` +
    `점수: ${result.score === null ? "-" : `${result.score}점`}\n` +
    `판정: ${result.decision}\n\n` +
        `진행중 건수: ${activeCount}건\n\n` +
    `거래건수: ${records.length}건\n\n` +
    `최근/관련 코드\n${recentRecords}`;
}

async function buildCustomerCreditReport(command) {
  if (!SHEET_ID) {
    return "⚠️ GOOGLE_SHEET_ID 환경변수가 설정되지 않았습니다.";
  }

  const accessToken = await getGoogleAccessToken();
  const values = await getSheetValues(accessToken);
  const records = findCreditRecords(values, command);

  if (records.length || command.type === "code") {
    return buildCreditReply(command, records);
  }

  const candidates = findSimilarCustomerCandidates(values, command.keyword);
  return buildSimilarCustomerReply(command.keyword, candidates);
}

function hasDollarToday(values, topIndex0, todayColumnIndex0) {
  const topRow = values[topIndex0] || [];
  const bottomRow = values[topIndex0 + 1] || [];
  const topToday = String(topRow[todayColumnIndex0] ?? "").trim();
  const bottomToday = String(bottomRow[todayColumnIndex0] ?? "").trim();
  return topToday === "$" || bottomToday === "$";
}

function parseBroadcastStartDate(todayInfo = null) {
  const today = todayInfo || getKoreaToday();
  const raw = String(LINE_BROADCAST_START_DATE || "").trim();
  const match = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);

  if (match) {
    return {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3])
    };
  }

  // 환경변수 형식이 잘못된 경우 현재 연도 4월 1일로 제한한다.
  return { year: today.year, month: 4, day: 1 };
}

function dateInfoToNumber(dateInfo) {
  return dateInfo.year * 10000 + dateInfo.month * 100 + dateInfo.day;
}

function parseCustomerStartDateFromRow(row) {
  const yearMonth = parseYearMonthValue(row?.[1]); // B열 년/월
  const dayRaw = String(row?.[7] ?? "").trim(); // H열 날짜

  if (!yearMonth || !dayRaw) return null;

  const year = getFullYearFromYearMonth(yearMonth);
  const month = Number(String(yearMonth).slice(2, 4));
  const day = Number(dayRaw.replace(/[^0-9]/g, ""));

  if (!Number.isInteger(day) || day < 1 || day > 31) return null;

  return { year, month, day };
}

function isBroadcastTargetDateRow(row, todayInfo = null) {
  const today = todayInfo || getKoreaToday();
  const startDate = parseBroadcastStartDate(today);
  const rowDate = parseCustomerStartDateFromRow(row);

  if (!rowDate) return false;

  const rowNumber = dateInfoToNumber(rowDate);
  return rowNumber >= dateInfoToNumber(startDate) && rowNumber <= dateInfoToNumber(today);
}

function findTodayDollarCodes(values, registeredCodes = null) {
  const today = getKoreaToday();
  const todayColumnIndex0 = findTodayColumnIndex(values, today.day);
  const codes = [];
  const seen = new Set();

  // 오늘상환 알림은 4월 1일부터 현재까지의 실제 고객 행만 검색한다.
  // 조건: B열 년/월 + H열 날짜가 유효하고, 상태가 진행중이며, 오늘 날짜 칸에 $가 있고, LINE그룹매핑에 등록된 코드.
  // 목차/구분행/이전 데이터가 후보에 섞여 크레딧이 과다 소모되는 것을 막기 위해 날짜 범위를 먼저 제한한다.
  for (let i = 1; i < values.length; i += 1) {
    const row = values[i] || [];
    const status = String(row[2] || "").trim(); // C열 상태
    const productName = String(row[5] || "").trim(); // F열 상품명

    if (!isBroadcastTargetDateRow(row, today)) continue;
    if (status !== "진행중") continue;

    const code = extractCustomerCodeFromProductName(productName);
    if (!code) continue;
    if (registeredCodes && !registeredCodes.has(code)) continue;

    if (!hasDollarToday(values, i, todayColumnIndex0)) continue;

    if (!seen.has(code)) {
      seen.add(code);
      codes.push(code);
    }
  }

  return codes;
}

function findActiveLineCustomerCodes(values) {
  const codes = [];
  const seen = new Set();

  // 미등록확인은 라인 그룹 고객 구간인 1058행부터, 고객 1명당 2행씩 검색
  for (let i = LINE_CUSTOMER_START_INDEX0; i < values.length; i += 2) {
    const row = values[i] || [];
    const status = String(row[2] || "").trim(); // C열 상태
    const productName = String(row[5] || "").trim(); // F열 상품명

    if (status !== "진행중") continue;

    const code = extractCustomerCodeFromProductName(productName);
    if (!code) continue;

    if (!seen.has(code)) {
      seen.add(code);
      codes.push(code);
    }
  }

  return codes;
}

async function checkUnregisteredGroups() {
  if (!SHEET_ID) {
    return "⚠️ GOOGLE_SHEET_ID 환경변수가 설정되지 않았습니다.";
  }

  const accessToken = await getGoogleAccessToken();
  const values = await getSheetValues(accessToken);
  const activeCodes = findActiveLineCustomerCodes(values);

  if (!activeCodes.length) {
    return "⚠️ 진행중 고객이 없습니다.";
  }

  const groupMapValues = await getGroupMapValues(accessToken);
  const registeredCodes = new Set();

  for (let i = 1; i < groupMapValues.length; i += 1) {
    const code = String(groupMapValues[i]?.[0] || "").trim().toUpperCase();
    const groupId = String(groupMapValues[i]?.[1] || "").trim();
    if (code && groupId) {
      registeredCodes.add(code);
    }
  }

  const unregisteredCodes = activeCodes.filter(code => !registeredCodes.has(code));

  if (!unregisteredCodes.length) {
    return "✅ 미등록 고객이 없습니다.";
  }

  return `❌ 미등록 고객\n\n${unregisteredCodes.join("\n")}`;
}

async function sendTodayRepaymentBroadcast(broadcastMessage) {
  if (!SHEET_ID) {
    return "⚠️ GOOGLE_SHEET_ID 환경변수가 설정되지 않았습니다.";
  }

  const accessToken = await getGoogleAccessToken();
  const values = await getSheetValues(accessToken);
  const groupMapValues = await getGroupMapValues(accessToken);
  const groupMap = new Map();
  const latestCodeByGroupId = new Map();

  // 같은 그룹ID가 여러 코드에 남아 있어도, 같은 그룹으로는 1회만 발송한다.
  // 시트 아래쪽 행을 나중 등록된 값으로 보고 우선 사용한다.
  for (let i = 1; i < groupMapValues.length; i += 1) {
    const code = String(groupMapValues[i]?.[0] || "").trim().toUpperCase();
    const groupId = String(groupMapValues[i]?.[1] || "").trim();
    if (code && groupId) {
      latestCodeByGroupId.set(groupId, code);
    }
  }

  for (const [groupId, code] of latestCodeByGroupId.entries()) {
    groupMap.set(code, groupId);
  }

  const rawCodes = findTodayDollarCodes(values, new Set(groupMap.keys()));
  const codes = [];
  const seenGroupIds = new Set();

  for (const code of rawCodes) {
    const groupId = groupMap.get(code);
    if (!groupId) continue;
    if (seenGroupIds.has(groupId)) continue;
    seenGroupIds.add(groupId);
    codes.push(code);
  }

  if (!codes.length) {
    return "⚠️ 오늘 발송 대상이 없습니다.";
  }

  const failedItems = [];
  let successCount = 0;

  // 기존 순차 발송 방식은 대상이 많을수록 1건씩 기다려서 느렸기 때문에
  // LINE_PUSH_CONCURRENCY 개수만큼 묶어서 병렬 발송한다.
  for (let start = 0; start < codes.length; start += LINE_PUSH_CONCURRENCY) {
    const chunk = codes.slice(start, start + LINE_PUSH_CONCURRENCY);

    const results = await Promise.all(
      chunk.map(async (code) => {
        const groupId = groupMap.get(code);

        if (!groupId) {
          return { code, ok: false, error: "등록된 그룹ID 없음" };
        }

        const result = await pushToLineWithRetry(code, groupId, broadcastMessage);

        if (!result.ok) {
          return { code, ok: false, error: result.error || "발송 실패" };
        }

        return { code, ok: true };
      })
    );

    for (const item of results) {
      if (item.ok) {
        successCount += 1;
      } else {
        failedItems.push({ code: item.code, error: item.error });
      }
    }

    // 동시 발송 묶음 사이에만 선택적으로 짧은 대기시간을 둘 수 있다.
    if (LINE_PUSH_DELAY_MS > 0 && start + LINE_PUSH_CONCURRENCY < codes.length) {
      await sleep(LINE_PUSH_DELAY_MS);
    }
  }

  if (failedItems.length) {
    const lines = failedItems.map(item => `${item.code} - ${item.error}`);
    return `❌ 발송 일부 실패\n\n✅ 성공: ${successCount}건\n❌ 실패: ${failedItems.length}건\n\n${lines.join("\n")}`;
  }

  return `✅ 발송 완료\n\n총 ${successCount}건 전송완료`;
}


function findTodayColumnIndex(values, day) {
  const header = values[0] || [];
  for (let col = DATE_START_COLUMN_INDEX; col <= DATE_END_COLUMN_INDEX; col += 1) {
    const cell = header[col];
    if (Number(cell) === Number(day)) return col;
  }
  return DATE_START_COLUMN_INDEX + day - 1;
}

function chooseTargetRow(values, topIndex0, todayColumnIndex0) {
  const topRow = values[topIndex0] || [];
  const bottomRow = values[topIndex0 + 1] || [];
  const topToday = topRow[todayColumnIndex0];
  const bottomToday = bottomRow[todayColumnIndex0];

  const dollarCandidates = [];
  const dashCandidates = [];
  const sumCandidates = [];

  // 입력 우선순위
  // 1순위: $ 칸에 신규 금액 입력
  // 2순위: $가 없을 때 - 칸에 신규 금액 입력
  // 3순위: $/-가 없고 숫자 칸이 정확히 1개일 때 기존값 + 신규값 합산
  // 공백, X, 기타 문자는 자동 입력 대상에서 제외
  if (String(topToday ?? "").trim() === "$") {
    dollarCandidates.push({ rowNumber: topIndex0 + 1, currentValue: topToday });
  } else if (String(topToday ?? "").trim() === "-") {
    dashCandidates.push({ rowNumber: topIndex0 + 1, currentValue: topToday });
  } else if (isActualPaymentCell(topToday)) {
    sumCandidates.push({ rowNumber: topIndex0 + 1, currentValue: topToday });
  }

  if (String(bottomToday ?? "").trim() === "$") {
    dollarCandidates.push({ rowNumber: topIndex0 + 2, currentValue: bottomToday });
  } else if (String(bottomToday ?? "").trim() === "-") {
    dashCandidates.push({ rowNumber: topIndex0 + 2, currentValue: bottomToday });
  } else if (isActualPaymentCell(bottomToday)) {
    sumCandidates.push({ rowNumber: topIndex0 + 2, currentValue: bottomToday });
  }

  if (dollarCandidates.length === 1) {
    return { status: "ok", mode: "new", ...dollarCandidates[0] };
  }

  if (dollarCandidates.length >= 2) {
    return { status: "multiple" };
  }

  if (dashCandidates.length === 1) {
    return { status: "ok", mode: "new", ...dashCandidates[0] };
  }

  if (dashCandidates.length >= 2) {
    return { status: "multiple" };
  }

  if (sumCandidates.length === 1) {
    return { status: "ok", mode: "sum", ...sumCandidates[0] };
  }

  if (sumCandidates.length >= 2) {
    return { status: "none" };
  }

  return { status: "none" };
}

async function addNextDayDollarIfBlank(accessToken, values, rowNumber, todayColumnIndex0, topRowNumber, todayInfo = null) {
  const today = todayInfo || getKoreaToday();
  const lastDayOfMonth = getDaysInMonth(today.year, today.month);

  let nextRowNumber = rowNumber;
  let nextColumnIndex0 = todayColumnIndex0 + 1;

  // 월말(28/29/30/31일)은 다음날이 1일이므로, 날짜 칸은 1일로 돌아가고 상/하 줄을 반대로 바꾼다.
  // 예: 상 31일 입력 -> 하 1일에 $, 하 31일 입력 -> 상 1일에 $
  if (today.day >= lastDayOfMonth) {
    nextColumnIndex0 = findTodayColumnIndex(values, 1);

    if (rowNumber === topRowNumber) {
      nextRowNumber = topRowNumber + 1;
    } else if (rowNumber === topRowNumber + 1) {
      nextRowNumber = topRowNumber;
    }
  }

  if (nextColumnIndex0 < DATE_START_COLUMN_INDEX || nextColumnIndex0 > DATE_END_COLUMN_INDEX) return false;

  const row = values[nextRowNumber - 1] || [];
  const nextValue = row[nextColumnIndex0];

  if (!isBlankCell(nextValue)) return false;

  await updateSheetCell(accessToken, nextRowNumber, nextColumnIndex0, "$");
  return true;
}


function getNextDayPosition(values, rowNumber, columnIndex0, topRowNumber, todayInfo = null) {
  const today = todayInfo || getKoreaToday();
  const lastDayOfMonth = getDaysInMonth(today.year, today.month);
  const dayNumber = columnIndex0 - DATE_START_COLUMN_INDEX + 1;

  if (dayNumber >= lastDayOfMonth) {
    return {
      rowNumber: rowNumber === topRowNumber ? topRowNumber + 1 : topRowNumber,
      columnIndex0: findTodayColumnIndex(values, 1)
    };
  }

  return { rowNumber, columnIndex0: columnIndex0 + 1 };
}

function chooseCountBaseRow(values, topRowNumber, todayColumnIndex0) {
  const topRow = values[topRowNumber - 1] || [];
  const bottomRow = values[topRowNumber] || [];
  const topToday = String(topRow[todayColumnIndex0] ?? "").trim();
  const bottomToday = String(bottomRow[todayColumnIndex0] ?? "").trim();

  // 오늘 날짜 기준으로 어느 줄의 다음 날짜부터 카운트를 이어갈지 판단한다.
  // 오늘 칸에 실제 금액/$/-가 있는 줄을 우선 사용한다.
  if (topToday === "$" || topToday === "-" || isActualPaymentCell(topToday)) {
    return topRowNumber;
  }

  if (bottomToday === "$" || bottomToday === "-" || isActualPaymentCell(bottomToday)) {
    return topRowNumber + 1;
  }

  // 오늘 칸이 둘 다 비어 있으면 기존 기준처럼 상단 줄의 다음 날짜부터 시작한다.
  return topRowNumber;
}

function chooseCountStartPosition(values, topRowNumber, todayColumnIndex0, todayInfo = null) {
  const rowNumber = chooseCountBaseRow(values, topRowNumber, todayColumnIndex0);

  // 카운트 명령어는 오늘 칸을 건드리지 않고, 항상 오늘 날짜 기준 다음 칸부터 시작한다.
  return getNextDayPosition(values, rowNumber, todayColumnIndex0, topRowNumber, todayInfo);
}

function isCountOverwriteCandidate(value) {
  const v = String(value ?? "").trim();

  // 카운트 명령은 공백, -, $만 덮어쓴다.
  // 숫자 실제 상환값, X, 기타 메모는 건드리지 않고 다음 날짜로 넘어간다.
  return isBlankCell(value) || v === "-" || v === "$";
}

async function applyCountPattern(accessToken, values, topRowNumber, todayColumnIndex0, count, todayInfo = null) {
  const today = todayInfo || getKoreaToday();
  const updates = [];
  let position = chooseCountStartPosition(values, topRowNumber, todayColumnIndex0, today);
  const maxScan = (DATE_END_COLUMN_INDEX - DATE_START_COLUMN_INDEX + 1) * 2;

  for (let scanned = 0; scanned < maxScan && updates.length < count; scanned += 1) {
    if (position.columnIndex0 < DATE_START_COLUMN_INDEX || position.columnIndex0 > DATE_END_COLUMN_INDEX) {
      break;
    }

    const row = values[position.rowNumber - 1] || [];
    const cellValue = row[position.columnIndex0];

    if (isCountOverwriteCandidate(cellValue)) {
      const value = updates.length === count - 1 ? "$" : "-";
      updates.push({ rowNumber: position.rowNumber, columnIndex0: position.columnIndex0, value });
      row[position.columnIndex0] = value;
      values[position.rowNumber - 1] = row;
    }

    position = getNextDayPosition(values, position.rowNumber, position.columnIndex0, topRowNumber, today);
  }

  for (const item of updates) {
    await updateSheetCell(accessToken, item.rowNumber, item.columnIndex0, item.value);
  }

  return updates.length;
}

function findExistingProductCustomer(values, productCode) {
  const targetCode = String(productCode || "").toUpperCase();
  if (!targetCode) return { exists: false, customerName: "", rowNumber: null };

  // 관리자별 코드는 고유하므로 F열 상품코드가 같은 이전 행을 기존 고객으로 판단한다.
  // 같은 코드가 여러 번 있으면 가장 아래쪽(최근) 행의 G열 고객명을 우선 반영한다.
  for (let i = values.length - 1; i >= 1; i -= 1) {
    const row = values[i] || [];
    const productName = String(row[5] || "").trim();
    if (!productName) continue;

    const existingCode = extractProductCode(productName);
    if (existingCode === targetCode) {
      return {
        exists: true,
        customerName: String(row[6] || "").trim(),
        rowNumber: i + 1
      };
    }
  }

  return { exists: false, customerName: "", rowNumber: null };
}

async function writeCustomerRegistration(command) {
  if (command.error) return command.error;

  if (!SHEET_ID) {
    return "⚠️ GOOGLE_SHEET_ID 환경변수가 설정되지 않았습니다.";
  }

  const accessToken = await getGoogleAccessToken();
  const values = await getSheetValues(accessToken);
  const today = getKoreaToday();
  const repaymentRows = buildRegistrationRepaymentRows(command, today);
  if (repaymentRows.error) return repaymentRows.error;

  const duplicateRows = [];
  for (let i = 1; i < values.length; i += 1) {
    const row = values[i] || [];
    const status = String(row[2] || "").trim();
    const productName = String(row[5] || "").trim();
    if (status !== "진행중") continue;

    const existingCode = extractProductCode(productName);
    if (existingCode === command.productCode) duplicateRows.push(i + 1);
  }

  if (duplicateRows.length > 0) {
    return `⚠️ ${command.productCode} 진행중 항목이 이미 있습니다. 중복 확인이 필요합니다. (${duplicateRows.join(", ")}행)`;
  }

  const existingCustomer = findExistingProductCustomer(values, command.productCode);
  const customerType = existingCustomer.exists ? "기존" : "신규";
  const resolvedCustomerName = command.customerName || existingCustomer.customerName || "";
  const nextNo = getNextCustomerNumber(values);
  const rowNumber = findNextCustomerWriteRow(values, nextNo);
  const dateText = formatKoreaDateValue(today);
  const monthDropdownText = formatKoreaYearMonthDropdownValue(today);
  // J/K열에는 기존 시트 수식이 있으므로 행 전체(A:AP)를 덮어쓰지 않는다.
  // 고객정보 영역(A:I)과 카운트 영역(L:AP)만 분리해서 업데이트한다.
  const topInfoValues = [[
    nextNo,
    monthDropdownText, // B열은 YY/MM 형식의 드롭다운 값을 사용한다. 예: 26/06
    "진행중",
    customerType,
    command.adminName,
    command.productName,
    resolvedCustomerName,
    dateText,
    formatAmountValue(command.loanAmount)
  ]];
  const bottomInfoValues = [["", "", "", "", "", "", "", "", ""]];

  await updateSheetRange(accessToken, rowNumber, 0, topInfoValues);
  await updateSheetRange(accessToken, rowNumber + 1, 0, bottomInfoValues);
  await updateSheetRange(accessToken, rowNumber, DATE_START_COLUMN_INDEX, [repaymentRows.topCells]);
  await updateSheetRange(accessToken, rowNumber + 1, DATE_START_COLUMN_INDEX, [repaymentRows.bottomCells]);

  return `✅ ${command.productCode}(${command.productAmount.toLocaleString("ko-KR")}) 고객등록 완료`;
}

async function writeCountCommand(command) {
  if (!SHEET_ID) {
    return "⚠️ GOOGLE_SHEET_ID 환경변수가 설정되지 않았습니다.";
  }

  const accessToken = await getGoogleAccessToken();
  const values = await getSheetValues(accessToken);
  const today = getKoreaToday();
  const todayColumnIndex0 = findTodayColumnIndex(values, today.day);

  const matches = [];
  for (let i = 1; i < values.length; i += 1) {
    const row = values[i] || [];
    const status = String(row[2] || "").trim();
    const productName = String(row[5] || "").trim();

    if (status !== "진행중") continue;

    const codeMatch = productName.match(/([A-Za-z]{1,3}\d{1,3})/);
    if (!codeMatch) continue;

    if (codeMatch[1].toUpperCase() === command.code) {
      matches.push({ rowIndex0: i, productName });
    }
  }

  if (matches.length === 0) {
    return `⚠️ ${command.code} 진행중 고객을 찾지 못했습니다.`;
  }

  if (matches.length > 1) {
    return `⚠️ ${command.code} 진행중 항목이 ${matches.length}개입니다. 중복 확인이 필요합니다.`;
  }

  const topRowNumber = matches[0].rowIndex0 + 1;
  const appliedCount = await applyCountPattern(accessToken, values, topRowNumber, todayColumnIndex0, command.count, today);

  if (appliedCount === 0) {
    return `⚠️ ${command.code} 카운트${command.count} 입력 가능한 칸이 없습니다.`;
  }

  if (appliedCount < command.count) {
    return `⚠️ ${command.code} 카운트${command.count} 중 ${appliedCount}개만 입력되었습니다.`;
  }

  return `✅ ${command.code} 카운트${command.count} 반영완료`;
}

async function writeSheetCommand(command) {
  if (!SHEET_ID) {
    return "⚠️ GOOGLE_SHEET_ID 환경변수가 설정되지 않았습니다.";
  }

  const accessToken = await getGoogleAccessToken();
  const values = await getSheetValues(accessToken);
  const today = getKoreaToday();
  const todayColumnIndex0 = findTodayColumnIndex(values, today.day);

  const matches = [];
  // 코드/숫자 입력은 전체 행을 검색하되, 상태가 진행중인 건만 반영
  // 고객 1명은 해당 행과 바로 아래 행 2줄 구조로 처리
  for (let i = 1; i < values.length; i += 1) {
    const row = values[i] || [];
    const status = String(row[2] || "").trim(); // C열 상태
    const productName = String(row[5] || "").trim(); // F열 상품명

    if (status !== "진행중") continue;

    const codeMatch = productName.match(/([A-Za-z]{1,3}\d{1,3})/);
    if (!codeMatch) continue;

    if (codeMatch[1].toUpperCase() === command.code) {
      matches.push({ rowIndex0: i, productName });
    }
  }

  if (matches.length === 0) {
    return `⚠️ ${command.code} 진행중 고객을 찾지 못했습니다.`;
  }

  if (matches.length > 1) {
    return `⚠️ ${command.code} 진행중 항목이 ${matches.length}개입니다. 중복 확인이 필요합니다.`;
  }

  const match = matches[0];
  const target = chooseTargetRow(values, match.rowIndex0, todayColumnIndex0);

  if (target.status === "multiple") {
    return "⚠️ 입력 가능 칸이 2개 발견되었습니다.";
  }

  if (target.status === "none") {
    return "⚠️ 입력 가능 칸이 없습니다.";
  }

  if (target.mode === "sum") {
    const currentAmount = parseAmountValue(target.currentValue);
    const addAmount = parseAmountValue(command.value);

    if (currentAmount === null || addAmount === null) {
      return "⚠️ 입력 가능 칸이 없습니다.";
    }

    const totalAmount = currentAmount + addAmount;
    const currentText = formatAmountValue(currentAmount);
    const addText = formatAmountValue(addAmount);
    const totalText = formatAmountValue(totalAmount);

    await updateSheetCell(accessToken, target.rowNumber, todayColumnIndex0, totalText);
    await addNextDayDollarIfBlank(accessToken, values, target.rowNumber, todayColumnIndex0, match.rowIndex0 + 1, today);

    return `✅ ${command.code} : ${currentText} + ${addText} = ${totalText}`;
  }

  const inputText = formatAmountValue(command.value);
  await updateSheetCell(accessToken, target.rowNumber, todayColumnIndex0, inputText);
  await addNextDayDollarIfBlank(accessToken, values, target.rowNumber, todayColumnIndex0, match.rowIndex0 + 1, today);

  return `✅ ${command.code} : ${inputText} 등록완료`;
}

async function applyClosedCustomerStyle(accessToken, topRowNumber) {
  const sheetId = await getSpreadsheetSheetId(accessToken, SHEET_NAME);
  if (sheetId === null || sheetId === undefined) {
    throw new Error(`${SHEET_NAME} 시트 ID를 찾지 못했습니다.`);
  }

  const closedFormat = {
    backgroundColor: CLOSED_BACKGROUND_RGB,
    textFormat: { foregroundColor: CLOSED_TEXT_RGB }
  };

  const requests = [
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: topRowNumber - 1,
          endRowIndex: topRowNumber,
          startColumnIndex: 0,
          endColumnIndex: DATE_END_COLUMN_INDEX + 1
        },
        cell: { userEnteredFormat: closedFormat },
        fields: "userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.foregroundColor"
      }
    },
    {
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: topRowNumber,
          endRowIndex: topRowNumber + 1,
          startColumnIndex: 10, // K열부터 하단 상환줄 스타일 적용
          endColumnIndex: DATE_END_COLUMN_INDEX + 1
        },
        cell: { userEnteredFormat: closedFormat },
        fields: "userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.foregroundColor"
      }
    }
  ];

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}:batchUpdate`;
  await axios.post(
    url,
    { requests },
    { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }
  );
}

async function closeSheetCustomer(command) {
  if (!SHEET_ID) {
    return "⚠️ GOOGLE_SHEET_ID 환경변수가 설정되지 않았습니다.";
  }

  const accessToken = await getGoogleAccessToken();
  const values = await getSheetValues(accessToken);
  const matches = [];

  for (let i = 1; i < values.length; i += 1) {
    const row = values[i] || [];
    const status = String(row[2] || "").trim(); // C열 상태
    const productName = String(row[5] || "").trim(); // F열 상품명

    if (status !== "진행중") continue;

    const codeMatch = productName.match(/([A-Za-z]{1,3}\d{1,3})/);
    if (!codeMatch) continue;

    if (codeMatch[1].toUpperCase() === command.code) {
      matches.push({ rowIndex0: i, productName });
    }
  }

  if (matches.length === 0) {
    return `⚠️ ${command.code} 진행중 고객을 찾지 못했습니다.`;
  }

  if (matches.length > 1) {
    return `⚠️ ${command.code} 진행중 항목이 ${matches.length}개입니다. 중복 확인이 필요합니다.`;
  }

  const topRowNumber = matches[0].rowIndex0 + 1;
  const managerProfit = parseCreditNumber((values[topRowNumber] || [])[10]); // K열 하단: 관리자수익
  const managerProfitText = managerProfit === null ? "확인불가" : formatAmountValue(managerProfit);

  await updateSheetCell(accessToken, topRowNumber, 2, "종료");
  await applyClosedCustomerStyle(accessToken, topRowNumber);

  return `✅ ${command.code} 종결 처리완료\n${managerProfitText}`;
}

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
  "응": "อืม",
  "네": "ครับ",
  "넵": "ครับ",
  "넹": "ครับ",
  "아니요": "ไม่ครับ",
  "맞아요": "ใช่ครับ",
  "답하세요": "ตอบด้วยครับ",
  "대답하세요": "ตอบด้วยครับ",
  "답변하세요": "ตอบกลับด้วยครับ",
  "답장하세요": "ตอบแชทด้วยครับ",
  "답해주세요": "ช่วยตอบด้วยครับ",
  "대답해주세요": "ช่วยตอบด้วยครับ",
  "답변해주세요": "ช่วยตอบกลับด้วยครับ",
  "답장해주세요": "ช่วยตอบแชทด้วยครับ",
  "잠시만요": "เดี๋ยวก่อนครับ",
  "잠깐만요": "เดี๋ยวก่อนครับ",
  "잠시": "เดี๋ยวก่อนครับ",
  "잠깐": "เดี๋ยวก่อนครับ"
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
  return String(text || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim();
}

function containsKorean(text) {
  return /[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(text || "");
}

function containsThai(text) {
  return /[\u0E00-\u0E7F]/.test(text || "");
}

function normalizeForLanguageCheck(text) {
  return normalizeText(text)
    .replace(/[\s.。!！?？~～…"'`]+/g, "")
    .toLowerCase();
}

function isBadKoToThOutput(sourceText, translatedText) {
  const source = normalizeForLanguageCheck(sourceText);
  const output = normalizeForLanguageCheck(translatedText);

  if (!output) return true;
  if (source && output === source) return true;

  // Korean -> Thai 결과에 한글이 남고 태국어가 없으면 실패로 판단
  if (containsKorean(translatedText) && !containsThai(translatedText)) return true;

  // 짧은 한국어 원문이 거의 그대로 반복되는 경우 방지
  if (source.length <= 20 && output.includes(source)) return true;

  return false;
}

function isBadThToKoOutput(sourceText, translatedText) {
  const source = normalizeForLanguageCheck(sourceText);
  const output = normalizeForLanguageCheck(translatedText);

  if (!output) return true;
  if (source && output === source) return true;

  // Thai -> Korean 결과에 태국어가 남고 한글이 없으면 실패로 판단
  if (containsThai(translatedText) && !containsKorean(translatedText)) return true;

  return false;
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

  if (!clean.startsWith("@")) {
    return false;
  }

  const lines = clean
    .split(/\n+/)
    .map(v => v.trim())
    .filter(Boolean);

  // 여러 줄이면 첫 줄이 멘션이어도 아래 줄에 실제 내용이 있다고 보고 번역 허용
  // 예:
  // @เอ็มดอย น้อง
  // เคลียร์ยอดให้หน่อยค่ะ
  if (lines.length >= 2) {
    const body = lines.slice(1).join(" ");
    if (/[가-힣\u0E00-\u0E7F]/u.test(body)) {
      return false;
    }
  }

  // 한 줄 메시지에서 @멘션 뒤에 공백 + 실제 문장이 있으면 번역 허용
  // 예: @พี่เม มาโอน
  const parts = clean.split(/\s+/).filter(Boolean);

  if (parts.length >= 2) {
    const afterMention = parts.slice(1).join(" ");

    const hasLanguage = /[가-힣\u0E00-\u0E7F]/u.test(afterMention);
    const hasSentenceSignal = /[가-힣]|(โอน|จ่าย|เคลียร์|ยอด|สลิป|เงิน|ชำระ|นัด|มา|ไป|ให้|หน่อย|แล้ว|ค่ะ|คะ|ครับ|คับ|นะ|อะ|จ้า|ได้|ไม่|ทำ|บอก|ถาม|รอ|ปิด|ค้าง|ครบ)/u.test(afterMention);

    if (hasLanguage && hasSentenceSignal) {
      return false;
    }

    // 멘션 뒤 단어가 2개 이상이면 실제 문장일 가능성이 높으므로 번역 허용
    if (hasLanguage && parts.length >= 3) {
      return false;
    }
  }

  // 순수 멘션만 무시
  // 예: @ยูนา / @Dex / @Melalada👑
  return /^@[^\s\n]+(?:\s[^\s\n]+)?[\p{Emoji_Presentation}\p{Extended_Pictographic}]?$/u.test(clean);
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

  return /[📌📣✅🔥💸✔️💛⚠️📍🚨🆘❗‼️⛔]/u.test(clean) || /sos/i.test(clean);
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


function containsNoTranslateAmount(text) {
  const clean = normalizeText(text);
  const compactNumberText = clean.replace(/[,\s]/g, "");

  // 2,000,000 또는 2000000 이 포함된 메시지는 번역하지 않음
  return clean.includes("2,000,000") || compactNumberText.includes("2000000");
}

function shouldIgnoreMessage(text) {
  const clean = normalizeText(text);
  const lowerClean = clean.toLowerCase();

  if (containsNoTranslateAmount(clean)) return true;

  for (const keyword of ignoreKeywords) {
    if (lowerClean.includes(String(keyword).toLowerCase())) return true;
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

async function replyToLineMessages(replyToken, messages) {
  return axios.post(
    "https://api.line.me/v2/bot/message/reply",
    { replyToken, messages },
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
      content: `최근 대화 맥락입니다. 짧은 단답 메시지의 경우 최근 맥락보다 원문 자체를 우선 해석하세요. 이 내용은 참고만 하고, 아래의 새 메시지만 번역하세요.\n\n${contextText}`
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

- Very important:
- For short Korean commands or acknowledgements, translate the exact intent into Thai.
- Never repeat Korean text in the output.
- Never answer the message; only translate it.
- Examples:
  - 답하세요 -> ตอบด้วยครับ
  - 대답하세요 -> ตอบด้วยครับ
  - 알겠습니다 -> รับทราบครับ
  - 네 -> ครับ

- Preserve teasing, soft joking, worry, frustration, apology, firmness, and affection naturally.
- Understand Korean casual expressions like ㅋㅋ, ㅎㅎ, ㅠㅠ, TT, 아/오/어/응/네.
- ㅋㅋ or ㅎㅎ may become 555 only when natural. Do not force it.
- Avoid robotic dictionary-style Thai.

- For mixed Korean + English phrases:
  preserve the English proper noun,
  but translate generic Korean words naturally.

Examples:
- PLP 그룹 -> กลุ่ม PLP
- KN 팀 -> ทีม KN
- VIP 고객 -> ลูกค้า VIP
- Line 그룹 -> กลุ่มไลน์
- Telegram 방 -> ห้อง Telegram


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

- Very important:
- For extremely short acknowledgement replies, prioritize the original message itself over conversation history.
- Never convert short acknowledgement replies into question tone unless the original message clearly contains a question mark or questioning intent.
- Do not output:
  - 네?
  - 응?
  - 왜요?
  - 예?
for messages like:
  - คะ
  - ค่ะ
  - ค่า
  - ครับ
  - คับ
  - อืม
  - โอเค
- Examples:
  - คะ -> 네
  - ค่ะ -> 네
  - ค่า -> 네
  - ครับ -> 네
  - อืม -> 응
  - โอเค -> 알겠습니다


Name preservation rules:
- Thai personal names or nicknames must NEVER be translated semantically.
- Preserve Thai nicknames as pronunciation-based Korean transliteration only.
- Never reinterpret names as ordinary vocabulary or implied meaning.
- Never invent dialogue, jokes, or hidden intent from names.
- Examples:
  - อ้อย -> 어이 (nickname)
  - ยูนา -> 유나
  - นาวี -> 나비

Meaning preservation rules:
- เจ้าหนี้ = 채권자
- ลูกหนี้ = 채무자
- คนปล่อยกู้ = 대출업자 / 돈을 빌려주는 사람
- Never translate any of the above as:
  - 사채업자
  - 불법대부업자
  - 대부업체
unless those exact meanings are explicitly written in Thai.

Ambiguity rules:
- Never answer the message.
- Never reinterpret emotional implication into a different sentence meaning.
- When emotional nuance is ambiguous, stay closer to the literal meaning.

Safety/accuracy rules:
- Do not add new money, dates, times, promises, threats, or legal/police wording.
- If the Thai is genuinely ambiguous, translate in a way that keeps the ambiguity rather than guessing too much.`;


function getThaiShortDirectTranslation(text) {
  const clean = normalizeText(text)
    .replace(/\s+/g, "")
    .replace(/[.。!！~～…]+$/g, "");

  if (/^(คะ|ค่ะ|ค่า|ค๊า|ค๋า|คร้า|จ้า|จ๊ะ|จ่ะ)$/u.test(clean)) {
    return "네";
  }

  // 단독 말끝 조사만 직접 변환
  if (/^(ครับ|คับ|ค้าบ|คร้าบ)$/u.test(clean)) {
    return "네";
  }

  if (/^(โอเค|ok|okay)$/iu.test(clean)) {
    return "알겠습니다";
  }

  if (/^(อืม|อือ|อ่า|อา)$/u.test(clean)) {
    return "응";
  }

  return null;
}

function normalizeShortKoreanResponse(text) {
  const clean = String(text || "").trim();

  const replacements = {
    "네?": "네",
    "응?": "응",
    "예?": "네",
    "어?": "어",
    "왜요?": "왜요",
    "그래요?": "그래요"
  };

  return replacements[clean] || clean;
}

async function translateKoToTh(text, history = []) {
  const clean = normalizeText(text);
  const direct = shortDictionary[clean];
  if (direct) return direct;

  let translated = await askOpenAI({
    systemPrompt: KO_TO_TH_SYSTEM_PROMPT,
    userText: clean,
    history,
    convertWonToThai: true
  });

  if (isBadKoToThOutput(clean, translated)) {
    translated = await askOpenAI({
      systemPrompt: `${KO_TO_TH_SYSTEM_PROMPT}

CRITICAL OUTPUT VALIDATION:
The input is Korean. The final answer must be Thai only.
Do not copy the Korean source text.
Do not leave any Korean letters in the output.
Translate the exact message into natural Thai.`,
      userText: clean,
      history: [],
      convertWonToThai: true
    });
  }

  return translated;
}

async function translateThToKo(text, history = []) {
  const clean = normalizeText(text);
  const shortDirect = getThaiShortDirectTranslation(clean);
  if (shortDirect) return shortDirect;

  const direct = thaiShortDictionary[clean];
  if (direct) return direct;

  let translated = await askOpenAI({
    systemPrompt: TH_TO_KO_SYSTEM_PROMPT,
    userText: clean,
    history,
    convertWonToThai: false
  });

  translated = normalizeShortKoreanResponse(translated);

  if (isBadThToKoOutput(clean, translated)) {
    translated = await askOpenAI({
      systemPrompt: `${TH_TO_KO_SYSTEM_PROMPT}

CRITICAL OUTPUT VALIDATION:
The input is Thai. The final answer must be Korean only.
Do not copy the Thai source text.
Do not leave Thai letters in the output.
Translate the exact message into natural Korean.`,
      userText: clean,
      history: [],
      convertWonToThai: false
    });

    translated = normalizeShortKoreanResponse(translated);
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

  // LINE에서 이미지 직후 스티커/이모티콘/텍스트가 빠르게 들어오면
  // 같은 webhook 배치 안에 여러 이벤트가 섞여 들어올 수 있다.
  // 입금 사진 분석은 후속 스티커 이벤트에 밀리거나 상태가 꼬이면 안 되므로
  // 1) 이미지 이벤트를 항상 먼저 처리하고
  // 2) 스티커/이모티콘 같은 비처리 메시지는 duplicate guard/상태 저장 전에 바로 무시한다.
  const sortedEvents = [...events].sort((a, b) => {
    const aImage = a?.type === "message" && a?.message?.type === "image" ? 0 : 1;
    const bImage = b?.type === "message" && b?.message?.type === "image" ? 0 : 1;
    return aImage - bImage;
  });

  for (const event of sortedEvents) {
    try {
      if (event.type === "postback") {
        const checkover = parseCheckOverPostback(event);
        if (checkover) {
          await handleCheckOverPostback(event, checkover);
          continue;
        }

        const receipt = parseReceiptPostback(event);
        if (receipt) {
          await handleReceiptPostback(event, receipt);
        }
        continue;
      }

      if (event.type !== "message") continue;

      // 스티커/이모티콘/파일/영상 등은 입금 이미지 분석과 무관하므로
      // message guard나 대화 상태에 영향을 주기 전에 즉시 무시한다.
      // 이미지 바로 뒤에 스티커가 올라와도 이미지 분석 흐름을 건드리지 않게 하기 위한 처리.
      if (!["image", "text"].includes(event.message?.type)) {
        console.log(`[LINE WEBHOOK SKIP] unsupported messageType=${event.message?.type || "unknown"} messageId=${event.message?.id || "unknown"}`);
        continue;
      }

      // LINE이 webhook 응답 지연/오류로 같은 이벤트를 다시 보낸 경우는 처리하지 않는다.
      // 사용자가 같은 명령어를 새로 다시 보내면 message.id가 달라서 정상 실행된다.
      if (event.deliveryContext?.isRedelivery) {
        console.log(`[LINE WEBHOOK SKIP] redelivery messageId=${event.message?.id || "unknown"}`);
        continue;
      }

      if (!markMessageProcessing(event)) {
        console.log(`[LINE WEBHOOK SKIP] duplicate messageId=${event.message?.id || "unknown"}`);
        continue;
      }

      if (event.message.type === "image") {
        await handleReceiptImageMessage(event);
        continue;
      }

      if (event.message.type !== "text") continue;

      const text = normalizeText(event.message.text);
      if (!text) continue;

      if (parseMyIdCommand(text)) {
        const userId = getLineUserId(event);
        await replyToLine(event.replyToken, userId ? `내아이디\n${userId}` : "⚠️ userId를 확인할 수 없습니다.");
        continue;
      }

      const registerGroupCommand = parseRegisterGroupCommand(text);
      if (registerGroupCommand) {
        if (!isAdmin(event)) {
          await replyUnauthorized(event);
          continue;
        }

        const registerReply = await registerGroupCode(registerGroupCommand, event);
        await replyToLine(event.replyToken, registerReply);
        continue;
      }

      if (parseUnregisteredCheckCommand(text)) {
        if (!isAdmin(event)) {
          await replyUnauthorized(event);
          continue;
        }

        const unregisteredReply = await checkUnregisteredGroups();
        await replyToLine(event.replyToken, unregisteredReply);
        continue;
      }

      const todayRepaymentBroadcastCommand = parseTodayRepaymentBroadcastCommand(text);
      if (todayRepaymentBroadcastCommand) {
        if (!isAdmin(event)) {
          await replyUnauthorized(event);
          continue;
        }

        const broadcastReply = await sendTodayRepaymentBroadcast(todayRepaymentBroadcastCommand.message);
        if (broadcastReply) {
          await replyToLine(event.replyToken, broadcastReply);
        }
        continue;
      }

      const creditCheckCommand = parseCreditCheckCommand(text);
      if (creditCheckCommand) {
        if (!isAdmin(event)) {
          await replyUnauthorized(event);
          continue;
        }

        const creditReply = await buildCustomerCreditReport(creditCheckCommand);
        await replyToLine(event.replyToken, creditReply);
        continue;
      }

      if (isCheckOverGuideCommand(text)) {
        await replyToLine(event.replyToken, buildCheckOverTemplateText());
        continue;
      }

      const checkOverCommand = parseCheckOverCommand(text);
      if (checkOverCommand) {
        if (checkOverCommand.error) {
          await replyToLine(event.replyToken, checkOverCommand.error);
          continue;
        }

        const confirmMessages = buildCheckOverConfirmMessages(checkOverCommand);
        await replyToLineMessages(event.replyToken, confirmMessages);
        await pushCheckOverConfirmToApprovalGroup(event, checkOverCommand);
        continue;
      }

      const customerRegisterCommand = parseCustomerRegisterCommand(text);
      if (customerRegisterCommand) {
        if (!isAdmin(event)) {
          await replyUnauthorized(event);
          continue;
        }

        const customerRegisterReply = await writeCustomerRegistration(customerRegisterCommand);
        await replyToLine(event.replyToken, customerRegisterReply);
        continue;
      }

      const closeCommand = parseCloseCommand(text);
      if (closeCommand) {
        if (!isAdmin(event)) {
          await replyUnauthorized(event);
          continue;
        }

        const closeReply = await closeSheetCustomer(closeCommand);
        await replyToLine(event.replyToken, closeReply);
        continue;
      }

      const countCommand = parseCountCommand(text);
      if (countCommand) {
        if (!isAdmin(event)) {
          await replyUnauthorized(event);
          continue;
        }

        const countReply = await writeCountCommand(countCommand);
        await replyToLine(event.replyToken, countReply);
        continue;
      }

      const sheetCommand = parseSheetCommand(text);
      if (sheetCommand) {
        if (!isAdmin(event)) {
          await replyUnauthorized(event);
          continue;
        }

        const sheetReply = await writeSheetCommand(sheetCommand);
        await replyToLine(event.replyToken, sheetReply);
        continue;
      }

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
