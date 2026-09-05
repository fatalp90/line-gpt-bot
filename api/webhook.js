import axios from "axios";
import crypto from "crypto";

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.4";
const MAX_HISTORY_ITEMS = 4;
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
const CHAT_RISK_LOG_SHEET_NAME = process.env.LINE_CHAT_RISK_LOG_SHEET_NAME || "LINE대화위험기록";
const CHAT_RISK_RESULT_LIMIT_RAW = Number(process.env.LINE_CHAT_RISK_RESULT_LIMIT || 10);
const CHAT_RISK_RESULT_LIMIT = Number.isFinite(CHAT_RISK_RESULT_LIMIT_RAW)
  ? Math.max(1, Math.floor(CHAT_RISK_RESULT_LIMIT_RAW))
  : 10;
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || "")
  .split(",")
  .map(v => v.trim())
  .filter(Boolean);

// 번역은 정확도를 위해 OPENAI_MODEL(gpt-5.4)을 그대로 사용한다.
// 이미지 OCR만 mini 모델을 기본값으로 사용해 비용을 줄인다.
const RECEIPT_OCR_MODEL = process.env.RECEIPT_OCR_MODEL || "gpt-5.4-mini";
const PASSPORT_OCR_MODEL = process.env.PASSPORT_OCR_MODEL || "gpt-5.4-mini";
const PASSPORT_BATCH_WAIT_MS = Number(process.env.PASSPORT_BATCH_WAIT_MS || 5000);
const PASSPORT_BATCH_TTL_MS = Number(process.env.PASSPORT_BATCH_TTL_MS || 60 * 1000);
const passportBatchCache = globalThis.__passportBatchCache || new Map();
globalThis.__passportBatchCache = passportBatchCache;
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
const CHECKOVER_PENDING_SHEET_NAME = process.env.CHECKOVER_PENDING_SHEET_NAME || "체크오버등록대기";
const DATE_CHANGE_BACKUP_SHEET_NAME = process.env.DATE_CHANGE_BACKUP_SHEET_NAME || "날짜변경백업";

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
const REPAYMENT_IGNORE_NOTICE = "(※ หากโอนเงินแล้ว หรือวันนี้ไม่ใช่วันชำระของคุณ กรุณาไม่ต้องสนใจข้อความนี้)";
const SHINHAN_LOGO_URL = String(
  process.env.SHINHAN_LOGO_URL
  || "https://www.shinhangroup.com/resources/publish/kr/images/common/favicon_192_192.png"
).trim();

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

function buildPaymentRequestFlexMessage() {
  return {
    type: "flex",
    altText: "แจ้งเตือนการชำระเงิน: ยังไม่พบยอดโอน",
    contents: {
      type: "bubble",
      size: "mega",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#00236E",
        paddingAll: "14px",
        spacing: "xs",
        contents: [
          { type: "text", text: "แจ้งเตือนการชำระเงิน", color: "#FFFFFF", size: "lg", weight: "bold", wrap: true }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "16px",
        spacing: "sm",
        contents: [
          {
            type: "box",
            layout: "horizontal",
            spacing: "sm",
            alignItems: "center",
            contents: [
              { type: "text", text: "⚠️", size: "sm", flex: 0 },
              {
                type: "text",
                text: "ยังไม่พบรายการโอน",
                color: "#B42318",
                size: "xl",
                weight: "bold",
                align: "center",
                wrap: true,
                flex: 1
              },
              { type: "text", text: "⚠️", size: "sm", align: "end", flex: 0 }
            ]
          },
          {
            type: "box",
            layout: "vertical",
            margin: "lg",
            backgroundColor: "#F5F7FA",
            cornerRadius: "md",
            paddingAll: "12px",
            spacing: "xs",
            contents: [
              {
                type: "box",
                layout: "horizontal",
                spacing: "sm",
                alignItems: "center",
                contents: [
                  { type: "image", url: SHINHAN_LOGO_URL, size: "20px", aspectMode: "fit", flex: 0 },
                  { type: "text", text: "SHINHAN BANK", color: "#0046FF", size: "sm", weight: "bold", flex: 1 }
                ]
              },
              {
                type: "box",
                layout: "baseline",
                spacing: "sm",
                contents: [
                  { type: "text", text: "เลขที่บัญชี", color: "#667085", size: "xs", flex: 2 },
                  { type: "text", text: "110551366954", color: "#101828", size: "md", weight: "bold", align: "end", flex: 3 }
                ]
              },
              {
                type: "box",
                layout: "baseline",
                spacing: "sm",
                contents: [
                  { type: "text", text: "ชื่อบัญชี", color: "#667085", size: "xs", flex: 2 },
                  { type: "text", text: "CHAYAPONE", color: "#101828", size: "sm", weight: "bold", align: "end", flex: 3 }
                ]
              }
            ]
          },
          {
            type: "box",
            layout: "vertical",
            backgroundColor: "#FFF4ED",
            cornerRadius: "md",
            paddingAll: "12px",
            spacing: "xs",
            margin: "sm",
            contents: [
              {
                type: "text",
                text: "⚠️ ค่าปรับกรณีชำระล่าช้า",
                color: "#B42318",
                size: "sm",
                weight: "bold",
                wrap: true
              },
              {
                type: "box",
                layout: "baseline",
                spacing: "sm",
                contents: [
                  { type: "text", text: "หลังเวลา 20:00 น.", color: "#7A271A", size: "xs", flex: 3 },
                  { type: "text", text: "20,000 วอน", color: "#B42318", size: "sm", weight: "bold", align: "end", flex: 2 }
                ]
              },
              {
                type: "box",
                layout: "baseline",
                spacing: "sm",
                contents: [
                  { type: "text", text: "หลังเวลา 00:00 น.", color: "#7A271A", size: "xs", flex: 3 },
                  { type: "text", text: "50,000 วอน", color: "#B42318", size: "sm", weight: "bold", align: "end", flex: 2 }
                ]
              }
            ]
          },
          {
            type: "text",
            text: "หากท่านชำระเงินแล้ว หรือวันนี้ไม่ใช่วันครบกำหนดชำระ กรุณาไม่ต้องดำเนินการใด ๆ",
            color: "#667085",
            size: "xxs",
            wrap: true,
            margin: "sm"
          }
        ]
      },
      footer: {
        type: "box",
        layout: "vertical",
        paddingAll: "12px",
        contents: [
          {
            type: "button",
            style: "primary",
            color: "#0046FF",
            height: "sm",
            action: {
              type: "clipboard",
              label: "คัดลอกเลขบัญชี",
              clipboardText: "110551366954"
            }
          }
        ]
      }
    }
  };
}


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


function columnLetterToIndex0(letter) {
  const clean = String(letter || "").trim().toUpperCase();
  if (!/^[A-Z]+$/.test(clean)) return NaN;
  let n = 0;
  for (const ch of clean) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
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
  const clean = normalizeText(normalizeEnglishKeyboardCommand(text)).replace(/\s+/g, "");
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
  KK: "유나",
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


function buildCheckOverCustomerAnalysisText(command) {
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
    "관리자 확인방으로 등록 요청을 보냈습니다."
  ].join("\n");
}

function buildCheckOverApprovalFlexMessage(command, params, cancelParams) {
  return {
    type: "flex",
    altText: `Check Over 등록 대기: ${command.productCode}`,
    contents: {
      type: "bubble",
      size: "mega",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          { type: "text", text: `📥 ${RECEIPT_APPROVAL_GROUP_CODE} Check Over 등록 대기`, weight: "bold", size: "md", wrap: true },
          { type: "separator", margin: "md" },
          { type: "text", text: `관리자 : ${command.adminName}`, size: "sm", wrap: true, margin: "md" },
          { type: "text", text: `코드 : ${command.productCode}`, size: "sm", wrap: true },
          { type: "text", text: `고객명 : ${command.customerName || "-"}`, size: "sm", wrap: true },
          { type: "text", text: `상품금액 : ${command.productAmount.toLocaleString("ko-KR")}`, size: "sm", wrap: true },
          { type: "text", text: `대출금 : ${formatAmountValue(command.loanAmount)}`, size: "sm", wrap: true },
          { type: "text", text: `공제 : ${formatAmountValue(command.cut)}`, size: "sm", wrap: true },
          { type: "text", text: "등록하시겠습니까?", weight: "bold", size: "sm", wrap: true, margin: "md" }
        ]
      },
      footer: {
        type: "box",
        layout: "horizontal",
        spacing: "sm",
        contents: [
          { type: "button", style: "primary", color: "#1E88E5", height: "sm", action: { type: "postback", label: "등록", data: params.toString(), displayText: "등록" } },
          { type: "button", style: "secondary", height: "sm", action: { type: "postback", label: "취소", data: cancelParams.toString(), displayText: "취소" } }
        ]
      }
    }
  };
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
  if (command.checkoverPendingId || options.pendingId) params.set("pid", String(command.checkoverPendingId || options.pendingId));

  // PP01 관리자 확인방에서 등록 버튼을 눌러도
  // 원본 고객방에 완료 메시지를 같이 보내기 위해 고객방 ID를 postback에 보관한다.
  if (options.sourceGroupId) params.set("sourceGroupId", String(options.sourceGroupId));

  const cancelParams = new URLSearchParams(params);
  cancelParams.set("action", "cancel");

  if (options.approvalNotice) {
    return [buildCheckOverApprovalFlexMessage(command, params, cancelParams)];
  }

  // 고객그룹방에는 등록/취소 버튼을 노출하지 않고 분석 결과만 보여준다.
  return [buildTextMessage(buildCheckOverCustomerAnalysisText(command))];
}

async function pushCheckOverConfirmToApprovalGroup(event, command) {
  try {
    const sourceGroupId = getLineSourceGroupId(event);
    if (!sourceGroupId) return;

    const accessToken = SHEET_ID ? await getGoogleAccessToken() : null;
    const approvalGroupId = await getReceiptApprovalGroupId(accessToken);
    if (!approvalGroupId || approvalGroupId === sourceGroupId) return;

    await pushToLineMessages(
      approvalGroupId,
      buildCheckOverConfirmMessages(command, { approvalNotice: true, sourceGroupId })
    );
  } catch (err) {
    const errorText = getLinePushErrorMessage(err);
    console.error(`[CHECKOVER APPROVAL PUSH FAIL] code=${command?.productCode || "-"} error=${errorText}`);
  }
}


function parseDateChangeCommand(text) {
  const clean = normalizeText(normalizeEnglishKeyboardCommand(text)).replace(/\s+/g, "");
  if (clean === "날짜변경") return { action: "change" };
  if (clean === "날짜복구") return { action: "restore" };
  return null;
}

function parseDateChangePostback(event) {
  const data = String(event?.postback?.data || "");
  const params = new URLSearchParams(data);
  if (params.get("datechange") !== "1") return null;

  const action = String(params.get("action") || "").trim();
  if (!["change", "restore", "cancel"].includes(action)) return null;
  return { action };
}

function buildDateChangeConfirmMessage(action) {
  const isRestore = action === "restore";
  return {
    type: "template",
    altText: isRestore ? "날짜복구 확인" : "날짜변경 확인",
    template: {
      type: "confirm",
      text: isRestore
        ? "⚠️ 마지막 날짜변경 작업을 복구하시겠습니까?"
        : "⚠️ 날짜를 변경하시겠습니까?\n오늘($) 생성 후 어제($→X)를 변경합니다.",
      actions: [
        {
          type: "postback",
          label: isRestore ? "복구하기" : "변경하기",
          data: `datechange=1&action=${isRestore ? "restore" : "change"}`,
          displayText: isRestore ? "날짜복구 실행" : "날짜변경 실행"
        },
        {
          type: "postback",
          label: "취소",
          data: "datechange=1&action=cancel",
          displayText: "취소"
        }
      ]
    }
  };
}

async function handleDateChangePostback(event, command) {
  if (!isAdmin(event)) {
    await replyUnauthorized(event);
    return;
  }

  if (command.action === "cancel") {
    await replyToLine(event.replyToken, "취소되었습니다.");
    return;
  }

  const reply = command.action === "restore"
    ? await restoreLastManualDateChange()
    : await runManualDateChange();

  await replyToLine(event.replyToken, reply);
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
  const sourceGroupId = String(params.get("sourceGroupId") || "").trim();
  const pendingId = String(params.get("pid") || "").trim();

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
    productAmount,
    sourceGroupId,
    pendingId
  };
}

async function retryPendingStatusUpdate(updateFn, label, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { await updateFn(); return true; }
    catch (err) {
      console.error(`[${label}] attempt=${attempt}/${attempts} error=${err?.response?.data?.error?.message || err?.message || err}`);
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 250 * attempt));
    }
  }
  return false;
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

  const accessToken = SHEET_ID ? await getGoogleAccessToken() : null;
  const pending = checkover.pendingId && accessToken
    ? await findCheckOverPending(accessToken, checkover.pendingId)
    : null;

  if (checkover.pendingId && !pending) {
    await replyToLine(event.replyToken, "⚠️ Check Over 등록 대기 정보를 찾지 못했습니다. 고객방에서 Check Over 양식을 다시 올려주세요.");
    return;
  }

  if (pending?.status === "completed") {
    await replyToLine(event.replyToken, pending.doneText || "⚠️ 이미 등록 완료된 Check Over입니다.");
    return;
  }

  if (["cancelled", "canceled"].includes(String(pending?.status || ""))) {
    await replyToLine(event.replyToken, pending.doneText || "⚠️ 이미 취소된 Check Over입니다.");
    return;
  }

  if (pending?.status === "processing") {
    await replyToLine(event.replyToken, "⚠️ 이미 처리 중인 Check Over입니다. 잠시 후 완료 메시지를 확인해주세요.");
    return;
  }

  if (checkover.action === "cancel") {
    if (pending && accessToken) {
      await updateCheckOverPendingStatus(accessToken, pending, "canceled");
    }
    await replyToLine(event.replyToken, `취소되었습니다.\n${checkover.productCode || ""}`);
    return;
  }

  if (pending && accessToken) {
    await updateCheckOverPendingStatus(accessToken, pending, "processing");
    pending.status = "processing";
  }

  const reply = await writeCustomerRegistration(checkover);

  if (pending && accessToken) {
    if (String(reply || "").startsWith("✅")) {
      await retryPendingStatusUpdate(() => updateCheckOverPendingStatus(accessToken, pending, "completed", reply), `CHECKOVER PENDING COMPLETE FAIL pendingId=${pending.pendingId}`);
    } else {
      await updateCheckOverPendingStatus(accessToken, pending, "pending");
    }
  }

  await replyToLine(event.replyToken, reply);

  // 등록이 성공한 경우, PP01에서 버튼을 눌러도 원본 고객방에 완료 메시지를 같이 보낸다.
  // 고객방에서 직접 눌렀다면 중복 발송을 피하기 위해 현재 방은 제외된다.
  if (String(reply || "").startsWith("✅")) {
    const clickedGroupId = getLineSourceGroupId(event);
    const sourceGroupId = checkover.sourceGroupId || pending?.sourceGroupId || "";
    const approvalGroupId = pending?.approvalGroupId || (accessToken ? await getReceiptApprovalGroupId(accessToken) : null);
    const pushFailures = await pushReceiptDoneToRelatedGroups({
      clickedGroupId,
      sourceGroupId,
      approvalGroupId,
      messages: [buildTextMessage(reply)]
    });

    if (pushFailures.length) {
      console.error(`[CHECKOVER DONE PUSH FAIL] ${pushFailures.join(" | ")}`);
    }
  }
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
  const clean = normalizeText(normalizeEnglishKeyboardCommand(text)).replace(/\s+/g, "");
  const match = clean.match(/^([A-Za-z]{1,3}\d{1,3})\/등록$/i);
  if (!match) return null;

  return {
    code: match[1].toUpperCase(),
    status: match[2]
  };
}


function parseCloseCommand(text) {
  const clean = normalizeText(normalizeEnglishKeyboardCommand(text)).replace(/\s+/g, "");
  const match = clean.match(/^([A-Za-z]{1,3}\d{1,3})\/(종료|종결|블랙)$/i);
  if (!match) return null;

  return {
    code: match[1].toUpperCase(),
    status: match[2] === "블랙" ? "블랙" : "종료"
  };
}

function parseCreditCheckCommand(text) {
  const clean = normalizeText(normalizeEnglishKeyboardCommand(text));
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

  const cutRaw = String(command.cut).trim();
  const cutNumber = cutRaw === "-" ? 0 : Number(cutRaw);
  const isNoCut = cutRaw === "-" || (Number.isFinite(cutNumber) && cutNumber <= 0);

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
    const prepaidCount = hasCut ? Math.min(plan.repaymentCount, Math.round(cutNumber / repaymentUnit)) : 0;

    if (!hasCut) {
      // 30만/40만/50만의 모든 매일상환 상품 공통:
      // 공제가 없으면 등록 당일은 '-'로 표시하고, 다음날부터 정해진 횟수만큼 '$'를 카운트한다.
      placeRegistrationCell(topCells, bottomCells, today, 0, "-");
      for (let i = 0; i < plan.repaymentCount; i += 1) {
        placeRegistrationCell(topCells, bottomCells, today, i + 1, "$");
      }
    } else {
      for (let i = 0; i < plan.repaymentCount; i += 1) {
        const value = i < prepaidCount ? repaymentValueText : "$";
        placeRegistrationCell(topCells, bottomCells, today, i, value);
      }
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

async function batchUpdateSheetCells(accessToken, updates) {
  const validUpdates = (updates || [])
    .filter(item => item && Number.isFinite(item.rowNumber) && Number.isFinite(item.columnIndex0));

  if (!validUpdates.length) return [];

  const data = validUpdates.map(item => {
    const columnLetter = columnNumberToLetter(item.columnIndex0 + 1);
    const range = `'${escapeSheetName(SHEET_NAME)}'!${columnLetter}${item.rowNumber}`;
    return {
      range,
      majorDimension: "ROWS",
      values: [[item.value]]
    };
  });

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values:batchUpdate`;
  await axios.post(
    url,
    { valueInputOption: "USER_ENTERED", data },
    { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }
  );

  return data.map(item => item.range);
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

function hasCustomerRegisterContent(row, ignoreCustomerNumber = false) {
  const cells = row || [];
  for (let i = 0; i <= DATE_END_COLUMN_INDEX; i += 1) {
    // 윗줄 A열에는 빈 양식에도 고객번호가 미리 들어가 있을 수 있다.
    if (ignoreCustomerNumber && i === 0) continue;
    // J/K열은 빈 양식에도 수식이 있을 수 있어서 신규 입력 위치 판단에서 제외한다.
    if (i === 9 || i === 10) continue;
    if (!isBlankCell(cells[i])) return true;
  }
  return false;
}

function isEmptyCustomerSlot(values, topIndex0) {
  const topRow = values[topIndex0] || [];
  const bottomRow = values[topIndex0 + 1] || [];

  // 고객번호와 양식 수식만 있는 2행 묶음만 빈 자리로 인정한다.
  // 특히 날짜칸(L:AP)에 -, $, 숫자 등 적용값이 하나라도 있으면 절대 재사용하지 않는다.
  return !hasCustomerRegisterContent(topRow, true)
    && !hasCustomerRegisterContent(bottomRow, false);
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

function findNextCustomerSlot(values) {
  const numberedSlots = [];
  let maxOccupiedCustomerNo = 0;
  let lastOccupiedRowNumber = 0;
  let lastNumberedRowNumber = 0;

  // 번호가 미리 입력된 모든 2행 양식을 확인한다.
  // 고객정보뿐 아니라 날짜칸 등 어느 곳에든 적용값이 있으면 사용 중인 자리로 본다.
  for (let i = 1; i < values.length; i += 1) {
    const row = values[i] || [];
    const no = parseCustomerNo(row[0]);
    if (!no) continue;

    const rowNumber = i + 1;
    const registered = isRegisteredCustomerTopRow(row);
    const occupied = registered || !isEmptyCustomerSlot(values, i);

    numberedSlots.push({ topIndex0: i, rowNumber, customerNo: no });
    lastNumberedRowNumber = Math.max(lastNumberedRowNumber, rowNumber);

    if (occupied) {
      lastOccupiedRowNumber = Math.max(lastOccupiedRowNumber, rowNumber);
      maxOccupiedCustomerNo = Math.max(maxOccupiedCustomerNo, no);
    }
  }

  // 체크오버 등록은 중간의 빈 구멍을 재사용하지 않고,
  // 마지막으로 사용된 자리 바로 다음에 있는 완전히 빈 2행 양식에만 추가한다.
  // 빈 양식 A열에 과거 번호가 중복으로 미리 들어 있어도 그 자리를 건너뛰지 않는다.
  // 위치는 첫 빈칸을 쓰고, 고객번호는 마지막 사용 번호의 다음 번호로 새로 기록한다.
  for (const slot of numberedSlots) {
    if (slot.rowNumber <= lastOccupiedRowNumber) continue;
    if (!isEmptyCustomerSlot(values, slot.topIndex0)) continue;

    return {
      rowNumber: slot.rowNumber,
      customerNo: maxOccupiedCustomerNo > 0 ? maxOccupiedCustomerNo + 1 : slot.customerNo
    };
  }

  // 준비된 빈 양식이 없으면 기존 번호 양식 전체의 아래쪽에 새 2행을 추가한다.
  // 이미 값이 있는 행을 덮지 않도록 마지막 등록 행이 아니라 마지막 번호 행을 기준으로 한다.
  return {
    rowNumber: Math.max(2, lastNumberedRowNumber + 2, lastOccupiedRowNumber + 2),
    customerNo: maxOccupiedCustomerNo + 1
  };
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

function extractChatRiskKeywords(text) {
  const clean = normalizeText(text);
  if (!clean) return [];

  const keywords = [];
  // BAD뿐 아니라 BAAD, BAAAD, BAAAAD처럼 A를 늘여 쓴 표현도 같은 BAD로 기록한다.
  if (/(^|[^A-Za-z])BA+D([^A-Za-z]|$)/i.test(clean)) keywords.push("BAD");
  if (/(^|[^A-Za-z])RUN([^A-Za-z]|$)/i.test(clean)) keywords.push("RUN");
  if (/블랙\s*리스트/.test(clean)) keywords.push("블랙리스트");
  if (/조회\s*가능/.test(clean)) keywords.push("조회 가능");
  return keywords;
}

function extractReferencedDateTokens(text) {
  const clean = normalizeText(text);
  if (!clean) return [];

  // 06/09, 6-9, 06.09, 2026/06/09처럼 대화 안에 직접 적은 날짜를 원문 그대로 보존한다.
  const matches = clean.match(/(?:\b\d{4}[./-])?\d{1,2}[./-]\d{1,2}\b/g) || [];
  return [...new Set(matches)].slice(0, 3);
}

async function ensureChatRiskLogSheet(accessToken) {
  const titles = await getSpreadsheetSheetTitles(accessToken);
  if (titles.includes(CHAT_RISK_LOG_SHEET_NAME)) return;

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}:batchUpdate`;
  try {
    await axios.post(
      url,
      { requests: [{ addSheet: { properties: { title: CHAT_RISK_LOG_SHEET_NAME } } }] },
      { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }
    );
  } catch (err) {
    // 배포 직후 여러 메시지가 동시에 들어오면 시트 생성 요청이 겹칠 수 있다.
    // 이미 같은 이름의 시트가 만들어진 경우만 계속 진행한다.
    const status = err?.response?.status;
    const message = String(err?.response?.data?.error?.message || err?.message || "");
    if (status !== 400 || !/already exists|이미 존재/i.test(message)) throw err;
  }

  const headerRange = `'${escapeSheetName(CHAT_RISK_LOG_SHEET_NAME)}'!A1:I1`;
  const headerUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(headerRange)}?valueInputOption=RAW`;
  await axios.put(
    headerUrl,
    { range: headerRange, majorDimension: "ROWS", values: [[
      "기록ID", "발생일시(KST)", "그룹ID", "그룹코드", "작성자ID", "키워드", "원문", "메시지ID", "타임스탬프(ms)"
    ]] },
    { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }
  );
}

async function getChatRiskLogValues(accessToken) {
  await ensureChatRiskLogSheet(accessToken);
  const range = `'${escapeSheetName(CHAT_RISK_LOG_SHEET_NAME)}'!A:I`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}`;
  const response = await axios.get(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  return response.data.values || [];
}

async function recordChatRiskMessage(event, text) {
  const keywords = extractChatRiskKeywords(text);
  const groupId = getLineSourceGroupId(event);
  if (!keywords.length || !groupId || !SHEET_ID) return false;

  const accessToken = await getGoogleAccessToken();
  const groupCode = await findMappedCodeByGroupId(accessToken, groupId) || "";
  await ensureChatRiskLogSheet(accessToken);

  const eventTimestamp = Number(event?.timestamp) || Date.now();
  const messageId = String(event?.message?.id || "");
  const recordId = messageId || crypto
    .createHash("sha256")
    .update(`${groupId}|${eventTimestamp}|${text}`, "utf8")
    .digest("hex")
    .slice(0, 24);
  const range = `'${escapeSheetName(CHAT_RISK_LOG_SHEET_NAME)}'!A:I`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;

  await axios.post(
    url,
    {
      range,
      majorDimension: "ROWS",
      values: [[
        recordId,
        getKoreaDateTimeText(new Date(eventTimestamp)),
        groupId,
        groupCode,
        getLineUserId(event),
        keywords.join(", "),
        text,
        messageId,
        eventTimestamp
      ]]
    },
    { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }
  );

  return true;
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


async function ensureCheckOverPendingSheet(accessToken) {
  const titles = await getSpreadsheetSheetTitles(accessToken);
  if (titles.includes(CHECKOVER_PENDING_SHEET_NAME)) return;

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}:batchUpdate`;
  await axios.post(
    url,
    { requests: [{ addSheet: { properties: { title: CHECKOVER_PENDING_SHEET_NAME } } }] },
    { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }
  );

  const headerRange = `'${escapeSheetName(CHECKOVER_PENDING_SHEET_NAME)}'!A:L`;
  const headerUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(headerRange)}?valueInputOption=USER_ENTERED`;
  await axios.put(
    headerUrl,
    { range: headerRange, majorDimension: "ROWS", values: [[
      "대기ID", "상태", "원본그룹ID", "승인그룹ID", "코드", "상품금액", "고객명", "대출금", "공제", "생성일시", "수정일시", "완료메시지"
    ]] },
    { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }
  );
}


async function ensureDateChangeBackupSheet(accessToken) {
  const titles = await getSpreadsheetSheetTitles(accessToken);
  if (titles.includes(DATE_CHANGE_BACKUP_SHEET_NAME)) return;

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}:batchUpdate`;
  await axios.post(
    url,
    { requests: [{ addSheet: { properties: { title: DATE_CHANGE_BACKUP_SHEET_NAME } } }] },
    { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }
  );

  const headerRange = `'${escapeSheetName(DATE_CHANGE_BACKUP_SHEET_NAME)}'!A1:H1`;
  const headerUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(headerRange)}?valueInputOption=USER_ENTERED`;
  await axios.put(
    headerUrl,
    { range: headerRange, majorDimension: "ROWS", values: [[
      "실행ID", "행번호", "어제열", "오늘열", "어제값", "오늘값", "백업일시", "상태"
    ]] },
    { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }
  );
}

async function clearDateChangeBackupSheet(accessToken) {
  await ensureDateChangeBackupSheet(accessToken);
  const range = `'${escapeSheetName(DATE_CHANGE_BACKUP_SHEET_NAME)}'!A2:H`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}:clear`;
  await axios.post(
    url,
    {},
    { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }
  );
}

async function appendDateChangeBackupRows(accessToken, rows) {
  await ensureDateChangeBackupSheet(accessToken);
  if (!rows?.length) return;

  const range = `'${escapeSheetName(DATE_CHANGE_BACKUP_SHEET_NAME)}'!A:H`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  await axios.post(
    url,
    { range, majorDimension: "ROWS", values: rows },
    { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }
  );
}

async function getDateChangeBackupValues(accessToken) {
  await ensureDateChangeBackupSheet(accessToken);
  const range = `'${escapeSheetName(DATE_CHANGE_BACKUP_SHEET_NAME)}'!A:H`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}`;
  const response = await axios.get(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  return response.data.values || [];
}

function makeCheckOverPendingId(command, sourceGroupId) {
  const raw = [
    "checkover",
    command?.productCode || "",
    command?.productAmount || "",
    command?.customerName || "",
    command?.loanAmount || "",
    command?.cut || "",
    sourceGroupId || "",
    Date.now(),
    Math.random()
  ].join("|");
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 20);
}

async function appendCheckOverPending(accessToken, item) {
  await ensureCheckOverPendingSheet(accessToken);
  const nowText = getKoreaDateTimeText();
  const range = `'${escapeSheetName(CHECKOVER_PENDING_SHEET_NAME)}'!A:L`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  await axios.post(
    url,
    { range, majorDimension: "ROWS", values: [[
      item.pendingId || "",
      item.status || "pending",
      item.sourceGroupId || "",
      item.approvalGroupId || "",
      item.code || "",
      item.productAmount || "",
      item.customerName || "",
      item.loanAmount || "",
      item.cut || "",
      nowText,
      nowText,
      item.doneText || (item.adminName ? `admin:${item.adminName}` : "")
    ]] },
    { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }
  );
}

function checkOverPendingFromRow(row, rowNumber) {
  return {
    rowNumber,
    pendingId: String(row?.[0] || "").trim(),
    status: String(row?.[1] || "").trim() || "pending",
    sourceGroupId: String(row?.[2] || "").trim(),
    approvalGroupId: String(row?.[3] || "").trim(),
    code: String(row?.[4] || "").trim().toUpperCase(),
    productAmount: Number(row?.[5]),
    customerName: String(row?.[6] || "").trim(),
    loanAmount: Number(row?.[7]),
    cut: Number(row?.[8]),
    adminName: String(row?.[11] || "").trim().startsWith("admin:")
      ? String(row?.[11] || "").trim().slice(6).trim()
      : "",
    doneText: String(row?.[11] || "").trim().startsWith("admin:")
      ? ""
      : String(row?.[11] || "").trim()
  };
}

async function findCheckOverPending(accessToken, pendingId) {
  const id = String(pendingId || "").trim();
  if (!id) return null;
  await ensureCheckOverPendingSheet(accessToken);
  const range = `'${escapeSheetName(CHECKOVER_PENDING_SHEET_NAME)}'!A:L`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}`;
  const response = await axios.get(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const values = response.data.values || [];
  for (let i = values.length - 1; i >= 1; i -= 1) {
    if (String(values[i]?.[0] || "").trim() === id) return checkOverPendingFromRow(values[i], i + 1);
  }
  return null;
}

async function updateCheckOverPendingStatus(accessToken, pending, status, doneText = "") {
  if (!pending?.rowNumber) return;
  const nowText = getKoreaDateTimeText();
  const range = `'${escapeSheetName(CHECKOVER_PENDING_SHEET_NAME)}'!B${pending.rowNumber}:L${pending.rowNumber}`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
  await axios.put(
    url,
    { range, majorDimension: "ROWS", values: [[
      status,
      pending.sourceGroupId || "",
      pending.approvalGroupId || "",
      pending.code || "",
      Number.isFinite(pending.productAmount) ? pending.productAmount : "",
      pending.customerName || "",
      Number.isFinite(pending.loanAmount) ? pending.loanAmount : "",
      Number.isFinite(pending.cut) ? pending.cut : "",
      "",
      nowText,
      doneText || pending.doneText || ""
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
    nearDuplicateKey: String(row?.[12] || "").trim(),
    createdAt: String(row?.[13] || "").trim(),
    updatedAt: String(row?.[14] || "").trim()
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


function parseKoreaDateTimeMs(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const [, y, mo, d, h, mi, s = "00"] = match;
  const ms = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}+09:00`);
  return Number.isFinite(ms) ? ms : null;
}

function isFreshReceiptPending(pending, ttlMs = RECEIPT_NEAR_DUPLICATE_TTL_MS) {
  const createdMs = parseKoreaDateTimeMs(pending?.createdAt);
  if (!createdMs) return false;
  return Date.now() - createdMs <= ttlMs;
}

async function findReceiptDuplicatePendingByKeys(accessToken, keys = {}) {
  const imageKey = String(keys.imageKey || "").trim();
  const infoKey = String(keys.infoKey || "").trim();
  const nearDuplicateKey = String(keys.nearDuplicateKey || "").trim();
  if (!imageKey && !infoKey && !nearDuplicateKey) return null;

  await ensureReceiptPendingSheet(accessToken);
  const range = `'${escapeSheetName(RECEIPT_PENDING_SHEET_NAME)}'!A:O`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}`;
  const response = await axios.get(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const values = response.data.values || [];

  for (let i = values.length - 1; i >= 1; i -= 1) {
    const pending = receiptPendingFromRow(values[i], i + 1);
    const status = String(pending.status || "").toLowerCase();

    // 1) 완전히 같은 이미지면 상태와 관계없이 중복으로 본다.
    if (imageKey && pending.imageKey && pending.imageKey === imageKey) {
      return pending;
    }

    // 2) 이체일시까지 포함된 정보키가 같으면 상태와 관계없이 동일 이체내역으로 본다.
    //    buildReceiptInfoKey는 날짜/시간이 확인되지 않으면 빈 값이므로,
    //    매일 같은 금액을 입금하는 고객이 금액만으로 막히지 않는다.
    if (infoKey && pending.infoKey && pending.infoKey === infoKey) {
      return pending;
    }

    // 3) 유사키는 위/아래로 나눠 찍은 캡처의 "등록 대기 중복"만 막는다.
    //    이미 완료/취소된 과거 입금은 매일 같은 금액 고객을 막을 수 있으므로 제외한다.
    if (
      nearDuplicateKey &&
      pending.nearDuplicateKey &&
      pending.nearDuplicateKey === nearDuplicateKey &&
      ["pending", "processing"].includes(status) &&
      isFreshReceiptPending(pending)
    ) {
      return pending;
    }
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


function buildCheckOverGroupMismatchMessage(currentCode, checkOverCode) {
  return [
    "⚠️ 고객방 등록 코드가 다릅니다.",
    "",
    `현재 등록된 코드 : ${currentCode || "-"}`,
    `체크오버 코드 : ${checkOverCode || "-"}`,
    "",
    "잘못된 고객방에서 Check Over를 작성했거나",
    "코드를 잘못 입력했을 수 있습니다.",
    "",
    "코드를 변경하려면 고객방에서",
    `${checkOverCode}/등록`,
    "명령어를 먼저 실행해주세요."
  ].join("\n");
}

function buildCheckOverCodeAlreadyMappedMessage(checkOverCode) {
  return [
    "⚠️ 이미 다른 고객방에 등록된 코드입니다.",
    "",
    `체크오버 코드 : ${checkOverCode || "-"}`,
    "",
    "관리자가 기존에 있는 코드를 잘못 적었을 수 있습니다.",
    "LINE그룹매핑 시트 또는 고객방 코드를 확인해주세요."
  ].join("\n");
}

async function ensureCheckOverGroupMapping(event, command) {
  if (!SHEET_ID) {
    return { ok: false, message: "⚠️ GOOGLE_SHEET_ID 환경변수가 설정되지 않았습니다." };
  }

  const sourceGroupId = getLineSourceGroupId(event);
  if (!sourceGroupId) {
    return { ok: false, message: "⚠️ Check Over는 그룹방에서만 등록 가능합니다." };
  }

  const checkOverCode = String(command?.productCode || "").trim().toUpperCase();
  if (!checkOverCode) {
    return { ok: false, message: "⚠️ Check Over 코드가 없습니다." };
  }

  const accessToken = await getGoogleAccessToken();
  const currentMappedCode = await findMappedCodeByGroupId(accessToken, sourceGroupId);

  // 이미 같은 코드로 등록된 고객방이면 자동 등록을 생략하고 그대로 진행한다.
  if (currentMappedCode === checkOverCode) {
    return { ok: true, sourceGroupId, currentMappedCode, autoRegistered: false };
  }

  // 같은 고객방이 다른 코드로 등록되어 있으면 오등록 방지를 위해 자동 변경하지 않는다.
  if (currentMappedCode && currentMappedCode !== checkOverCode) {
    return {
      ok: false,
      sourceGroupId,
      currentMappedCode,
      message: buildCheckOverGroupMismatchMessage(currentMappedCode, checkOverCode)
    };
  }

  const targetMappedGroupId = await findMappedGroupId(accessToken, checkOverCode);

  // 고객방은 미등록인데, 체크오버 코드가 이미 다른 고객방에 등록되어 있으면 오입력 가능성이 높으므로 중단한다.
  if (targetMappedGroupId && targetMappedGroupId !== sourceGroupId) {
    return {
      ok: false,
      sourceGroupId,
      message: buildCheckOverCodeAlreadyMappedMessage(checkOverCode)
    };
  }

  // 고객방도 미등록이고 코드도 다른 고객방에 사용 중이 아니면 자동으로 코드/등록 처리한다.
  const autoRegisterReply = await registerGroupCode({ code: checkOverCode }, event);
  if (!String(autoRegisterReply || "").startsWith("✅")) {
    return { ok: false, sourceGroupId, message: autoRegisterReply || "⚠️ 고객방 자동 그룹등록에 실패했습니다." };
  }

  return { ok: true, sourceGroupId, currentMappedCode: checkOverCode, autoRegistered: true, autoRegisterReply };
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

function normalizeReceiptDepositWonAmount(value) {
  const n = normalizeWonAmount(value);
  if (!n || n < 1000) return null;

  // 운영 기준: 실제 입금액은 1,000원 단위로 처리한다.
  // OCR/앱 표기상 80,500처럼 100원 단위가 섞이면 80,000으로 내림 보정한다.
  return Math.floor(n / 1000) * 1000;
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
  const actualName = normalizeSenderName(senderName);
  const actualAccount = normalizeAccountNumber(accountNumber);

  // 불일치라고 단정하지 않고 관리자가 사진을 다시 볼 수 있도록 안내한다.
  const nameStatus = actualName && isExpectedReceiptSender(actualName)
    ? "✅ 일치"
    : "⚠️ 확인 필요";
  const accountStatus = actualAccount && isExpectedReceiptAccount(actualAccount)
    ? "✅ 일치"
    : "⚠️ 확인 필요";

  return [
    `입금자명 확인 : ${nameStatus}`,
    `계좌번호 확인 : ${accountStatus}`
  ].join("\n");
}

function isExpectedReceiptAccount(accountNumber) {
  const expected = normalizeAccountNumber(RECEIPT_EXPECTED_ACCOUNT_NUMBER);
  const actual = normalizeAccountNumber(accountNumber);
  if (!expected || !actual) return false;
  return actual === expected;
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

function normalizeReceiptNameList(parsed) {
  const rawNames = [
    parsed?.sender_name,
    parsed?.recipient_name,
    parsed?.account_owner_name,
    parsed?.displayed_self_name,
    parsed?.displayed_recipient_name,
    ...(Array.isArray(parsed?.all_names) ? parsed.all_names : [])
  ];

  const names = [];
  const seen = new Set();
  for (const value of rawNames) {
    const name = normalizeSenderName(value);
    const key = normalizeReceiptNameForCompare(name);
    if (!name || !key || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

function selectExpectedReceiptName(names, fallback = "") {
  const list = Array.isArray(names) ? names : [];
  const matched = list.find(name => isExpectedReceiptSender(name));
  return matched || normalizeSenderName(fallback) || list[0] || "";
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

function buildReceiptInfoKey({ sourceGroupId, code, amountWon, senderName, accountNumber, transferDate }) {
  const amount = normalizeWonAmount(amountWon) || "";
  const sender = normalizeReceiptKeyPart(normalizeSenderName(senderName));
  const account = normalizeAccountNumber(accountNumber) || "";
  const date = normalizeReceiptKeyPart(normalizeTransferDate(transferDate));

  // 매일 같은 금액을 입금하는 고객이 있으므로, 날짜/시간을 못 읽은 경우에는
  // 금액+계좌만으로 "이미 등록 완료" 중복 판정을 하지 않는다.
  // 정확한 완료 중복 판정은 이미지가 완전히 같거나, 이체일시까지 확인되는 경우만 사용한다.
  if (!sourceGroupId || !code || !amount || !date) return "";

  const parts = [sourceGroupId, String(code || "").toUpperCase(), amount, sender, account, date].filter(Boolean);
  return crypto.createHash("sha256").update(parts.join("|"), "utf8").digest("hex");
}

function buildReceiptImageKey({ sourceGroupId, imageHash }) {
  if (!imageHash) return "";
  return crypto.createHash("sha256").update(`${sourceGroupId || ""}|${imageHash}`, "utf8").digest("hex");
}

function buildReceiptNearDuplicateKey({ sourceGroupId, code, amountWon, senderName, accountNumber }) {
  const amount = normalizeWonAmount(amountWon) || "";
  if (!sourceGroupId || !code || !amount) return "";

  const actualSender = normalizeSenderName(senderName);
  const actualAccount = normalizeAccountNumber(accountNumber);
  const senderMatched = actualSender && isExpectedReceiptSender(actualSender);

  // 계좌번호는 은행마다 고객/당사/출금계좌 등 의미가 달라질 수 있으므로
  // 기대 계좌 일치 여부로 판단하지 않는다. 입금자명이 일치할 때만 동일 입금 단서로 사용한다.
  const matchPart = senderMatched ? "expected" : `${actualSender || ""}|${actualAccount || ""}`;
  return crypto.createHash("sha256").update(`${sourceGroupId}|${String(code).toUpperCase()}|${amount}|${matchPart}`, "utf8").digest("hex");
}

function buildReceiptDuplicateText(item) {
  if (item?.status === "confirmed") return "⚠️ 이미 등록 완료된 동일한 이체사진/이체내역입니다.";
  if (item?.status === "processing") return "⚠️ 이미 등록 처리 중인 동일한 이체사진/이체내역입니다.";
  if (item?.status === "cancelled") return "⚠️ 이미 취소 처리된 동일한 이체사진/이체내역입니다.";
  return "⚠️ 이미 분석된 동일한 이체사진/이체내역입니다. PP01 관리자 확인방의 기존 등록 요청을 확인해주세요.";
}

function buildReceiptAnalysisText({ code, amountWon, sheetValue, senderName, accountNumber, transferDate, includePrompt = true }) {
  const matchText = buildReceiptMatchText({ senderName, accountNumber });
  const promptText = includePrompt ? "\n\n💛 등록하시겠습니까?" : "";
  return `💛이체사진 분석완료\n\n고객코드 : ${code}\n이체날짜 : ${formatTransferDate(transferDate)}\n입금금액 : ${formatWon(amountWon)}\n입력값 : ${sheetValue}\n입금자명 : ${formatOptionalReceiptField(senderName)}\n\n${matchText}${promptText}`;
}

function buildTextMessage(text, quickReply) {
  return {
    type: "text",
    text,
    ...(quickReply ? { quickReply } : {})
  };
}

function isTransferCompleteCommand(text) {
  const clean = normalizeText(normalizeEnglishKeyboardCommand(text)).replace(/\s+/g, "");
  return clean === "송금완료";
}

const TRANSFER_COMPLETE_CREDIT_MESSAGE = "รักษาเครดิตนะครับ";

function buildTransferCompleteFlexMessage() {
  return {
    type: "flex",
    altText: "송금완료",
    contents: {
      type: "bubble",
      size: "kilo",
      body: {
        type: "box",
        layout: "vertical",
        alignItems: "center",
        spacing: "md",
        paddingAll: "24px",
        contents: [
          {
            type: "text",
            text: "💸",
            size: "5xl",
            align: "center"
          },
          {
            type: "text",
            text: "โอนเงินเรียบร้อยแล้ว",
            weight: "bold",
            size: "lg",
            align: "center",
            wrap: true
          },
          {
            type: "text",
            text: "송금이 완료되었습니다.",
            size: "sm",
            color: "#888888",
            align: "center",
            wrap: true
          }
        ]
      }
    }
  };
}

async function callReceiptOcrOpenAI(image, retry = false) {
  const receiptSystemPrompt = retry
    ? "너는 한국 은행/간편송금 이체 캡처 이미지 재검토 OCR 분석기다. 1차 분석에서 등록 버튼을 만들지 못한 이미지를 다시 확인한다. 이미지는 모니터/ATM/휴대폰 화면을 다시 촬영한 사진일 수 있고, 반사광/유리빛/기울어짐/부분 가림/흐림/흔들림이 있거나, 화면이 가로/세로/90도/180도/270도 회전되어 있을 수 있으므로 반드시 가능한 모든 방향으로 돌려 읽는다고 가정한다. 실제 은행/금융앱/간편송금 앱의 이체 완료, 송금 완료, 입금 완료, 거래 영수증, 거래 확인 화면인지 먼저 판별한다. 단, 금액이 보인다고 해서 안내 포스터, 광고, 이벤트, 연체/벌금/납부 안내, 채팅 캡처, 일반 스크린샷이면 is_transfer_receipt=false로 둔다. 실제 금융앱 거래 화면으로 보이고 송금 금액이 사람 눈으로 읽히면 confidence를 과도하게 낮추지 마라. 금액은 KRW 55,000 / KRW55,000 / 55,000 KRW / ₩55,000 / 55000 / 55.000처럼 붙거나 줄이 나뉘거나 구분자가 달라도 같은 금액으로 인식한다. amount_won은 실제 상대방에게 송금/입금되는 순수 입금액만 넣는다. 수수료, 잔액, 한도, 벌금, 연체료, 날짜 숫자는 입금액으로 선택하지 마라. 송금액과 잔액을 특히 구분한다. 절대 잔액/남은금액/Remaining Balance/Available Balance/Balance/ยอดเงินคงเหลือ/คงเหลือ 옆 숫자를 amount_won으로 선택하지 마라. 태국어 영수증 예시: ยอดเงินที่โอน -80,500 / ค่าธรรมเนียม 0 / ยอดเงินคงเหลือ KRW 55,358 이면 amount_won=80500, fee_won=0, balance_won=55358 이다. 또 다른 예시: จำนวนเงินโอน 130,900 이면 amount_won=130900으로 읽고 후처리에서 130,000원으로 내림될 수 있다. 특히 화면에 송금액과 수수료가 따로 있고 총 결제금액/납부금액/합계가 크게 표시되는 경우, 총액이 더 크게 보이더라도 amount_won에는 송금액만 넣고 수수료 포함 총액은 제외한다. 금액 후보가 여러 개이면 Transfer amount / Amount to transfer / Sent amount / 송금액 / 이체금액 / 입금액 / จำนวนเงินที่ต้องการโอน / จำนวนเงินโอน / ยอดเงินที่โอน 같은 라벨 옆 금액을 우선하고, Fee / Charge / 수수료 / ค่าธรรมเนียม 및 Total / Amount to pay / 총 결제금액 / 합계 / จำนวนที่ต้องชำระ / Balance / Remaining Balance / 잔액 / 남은금액 / ยอดเงินคงเหลือ / คงเหลือ 라벨 옆 금액은 제외한다. 계좌번호에 하이픈/공백이 있어도 숫자만 기준으로 읽는다. 화면의 모든 이름 후보 또는 계좌번호 중 하나라도 기대값과 강하게 일치하고 금액이 확실하면, 화면 일부가 가려져도 등록 가능한 이체사진으로 판단한다. 특히 계좌번호 110551366954 또는 CHAYAPONE 계열 이름이 보이면 receipt_score와 confidence를 과도하게 낮추지 마라. 또한 검은 배경의 송금 완료 화면에서 중앙에 영문 이름(예: CHAYAPONE)과 “50,000 KRW”처럼 금액이 크게 표시되고, 태국어 “การส่งเงิน”, “กำลังดำเนินการ”, “เสร็จสิ้น”, “ดูรายละเอียด”, “ดำเนินการโอนเงินต่อ”, “ยืนยัน” 문구 또는 카카오톡/MMS 공유 버튼이 보이는 화면은 실제 금융앱 송금 완료 화면으로 판단한다. 완료 애니메이션 때문에 “กำลังดำเนินการ”와 “เสร็จสิ้น” 문구가 겹쳐 보여도, 이름과 KRW 금액이 명확하면 is_transfer_receipt=true로 두고 amount_won을 추출한다. 화면 상단의 은행 입출금 알림 배너는 다른 앱 알림이므로 송금 화면 판별과 금액 추출을 방해하는 요소로 보지 말고 무시한다. 한 이미지 안에 같은 송금내역의 상단/하단 화면이 나란히 붙어 있거나, 같은 송금내역이 여러 장 캡처로 보이더라도 하나의 이체로만 판단하고 가장 명확한 송금금액 1개만 amount_won에 넣는다. 반드시 JSON만 출력한다."
    : "너는 한국 은행/간편송금 이체 캡처 이미지 판별 및 OCR 분석기다. 이미지는 모니터/ATM/휴대폰 화면을 다시 촬영한 사진일 수 있고, 반사광/유리빛/기울어짐/부분 가림/흐림/흔들림이 있거나, 세로/가로/90도/180도/270도 회전 상태일 수 있으므로 반드시 가능한 모든 방향으로 돌려 읽는다고 가정하고 분석한다. 가장 먼저 이미지가 실제 은행/금융앱/간편송금 앱의 이체 완료, 송금 완료, 입금 완료, 거래 영수증, 거래 확인 화면인지 엄격하게 판별한다. 금액 숫자가 있어도 안내 포스터, 광고 이미지, 이벤트 배너, 연체/벌금/납부 안내 이미지, 채팅 캡처, 일반 스크린샷, 인물/풍경/상품/문서 사진이면 반드시 is_transfer_receipt=false, receipt_score는 낮게 둔다. 실제 금융앱 거래 완료/확인 화면이라는 증거가 강할 때만 is_transfer_receipt=true로 둔다. 특히 흰 배경의 Transaction result 또는 Transaction detail 화면에 Completed/Completion date, Recipient name, Recipient account, 송금액이 함께 표시되면 명백한 이체 완료 화면이다. Hanpass 화면에서 태국어 ยอดโอน은 송금액, ค่าธรรมเนียม은 수수료다. 예를 들어 Recipient name CHAYAPONE, ยอดโอน 380,000KRW, ค่าธรรมเนียม 1,500KRW, Recipient account Shinhan Bank 110551366954, 하단 Completed가 보이면 amount_won=380000, fee_won=1500, recipient_name=CHAYAPONE, account_number=110551366954, is_transfer_receipt=true로 반환한다. Withdrawal account/Hanpass Pay Wallet/RULA로 시작하는 값은 출금 지갑이므로 account_number에 넣지 말고 반드시 Recipient account 아래의 수취계좌를 넣는다. 이 경우 receipt_score와 confidence는 높게 두고 금액·수취계좌·완료시각을 추출한다. 이체 캡처라면 실제 이체/송금/입금 금액, 이체 날짜/시간, 계좌번호를 추출하고, 화면에 보이는 모든 영문 이름을 역할별로 분리한다. sender_name 하나로 임의 단정하지 말고 recipient_name, account_owner_name, displayed_self_name, displayed_recipient_name 및 all_names 배열에 보이는 이름을 빠짐없이 넣는다. 태국어 라벨 แสดงให้ผู้รับเห็น 옆 이름은 displayed_recipient_name, แสดงต่อตนเอง 옆 이름은 displayed_self_name으로 분류한다. KRW 55,000 / KRW55,000 / 55,000 KRW / ₩55,000 / 55000 처럼 붙어있거나 줄이 나뉜 금액도 같은 금액으로 인식한다. amount_won은 실제 상대방에게 송금/입금되는 순수 입금액만 넣는다. 수수료, 잔액, 한도, 벌금, 연체료, 날짜 숫자는 입금액으로 선택하지 마라. 송금액과 잔액을 특히 구분한다. 절대 잔액/남은금액/Remaining Balance/Available Balance/Balance/ยอดเงินคงเหลือ/คงเหลือ 옆 숫자를 amount_won으로 선택하지 마라. 태국어 영수증 예시: ยอดเงินที่โอน -80,500 / ค่าธรรมเนียม 0 / ยอดเงินคงเหลือ KRW 55,358 이면 amount_won=80500, fee_won=0, balance_won=55358 이다. 또 다른 예시: จำนวนเงินโอน 130,900 이면 amount_won=130900으로 읽고 후처리에서 130,000원으로 내림될 수 있다. 특히 화면에 송금액과 수수료가 따로 있고 총 결제금액/납부금액/합계가 크게 표시되는 경우, 총액이 더 크게 보이더라도 amount_won에는 송금액만 넣고 수수료 포함 총액은 제외한다. 금액 후보가 여러 개이면 Transfer amount / Amount to transfer / Sent amount / 송금액 / 이체금액 / 입금액 / จำนวนเงินที่ต้องการโอน / จำนวนเงินโอน / ยอดโอน / ยอดเงินที่โอน 같은 라벨 옆 금액을 우선하고, Fee / Charge / 수수료 / ค่าธรรมเนียม 및 Total / Amount to pay / 총 결제금액 / 합계 / จำนวนที่ต้องชำระ / Balance / Remaining Balance / 잔액 / 남은금액 / ยอดเงินคงเหลือ / คงเหลือ 라벨 옆 금액은 제외한다. 계좌번호에 하이픈이나 공백이 있어도 숫자만 기준으로 읽는다. 흐리거나 화면에 없는 값은 null로 둔다. 금액이 사람 눈으로 충분히 읽히거나 계좌번호 110551366954 또는 CHAYAPONE 계열 이름이 보이면 confidence를 과도하게 낮추지 마라. 또한 검은 배경의 송금 완료 화면에서 중앙에 영문 이름(예: CHAYAPONE)과 “50,000 KRW”처럼 금액이 크게 표시되고, 태국어 “การส่งเงิน”, “กำลังดำเนินการ”, “เสร็จสิ้น”, “ดูรายละเอียด”, “ดำเนินการโอนเงินต่อ”, “ยืนยัน” 문구 또는 카카오톡/MMS 공유 버튼이 보이는 화면은 실제 금융앱 송금 완료 화면으로 판단한다. 완료 애니메이션 때문에 “กำลังดำเนินการ”와 “เสร็จสิ้น” 문구가 겹쳐 보여도, 이름과 KRW 금액이 명확하면 is_transfer_receipt=true로 두고 amount_won을 추출한다. 화면 상단의 은행 입출금 알림 배너는 다른 앱 알림이므로 송금 화면 판별과 금액 추출을 방해하는 요소로 보지 말고 무시한다. 한 이미지 안에 같은 송금내역의 상단/하단 화면이 나란히 붙어 있거나, 같은 송금내역이 여러 장 캡처로 보이더라도 하나의 이체로만 판단하고 가장 명확한 송금금액 1개만 amount_won에 넣는다. 반드시 JSON만 출력한다.";

  const systemPrompt = `이미지를 한 번만 분석하여 document_type을 passport, passport_selfie, receipt, other 중 하나로 분류한다.
여권 인적사항면이 사진의 중심에 크고 선명하게 촬영되어 이름 또는 MRZ를 글자 단위로 읽을 수 있을 때만 document_type="passport", is_passport=true, is_transfer_receipt=false로 두고 surname, given_names, mrz_line1을 추출한다. 여권번호, 생년월일 등 다른 개인정보는 출력하지 않는다. MRZ의 P< 다음 국가코드 3글자는 이름에서 제외한다.
사람의 얼굴이나 상반신이 사진의 큰 부분을 차지하고 그 사람이 펼친 여권을 들고 있는 본인확인 사진, 셀카, 인증사진이면 document_type="passport_selfie", is_passport=false, is_transfer_receipt=false로 둔다. 이런 사진 속의 작거나 기울어진 여권에서는 이름을 추출하지 말고 surname, given_names, mrz_line1을 모두 비운다. 같은 사용자가 여권 단독 사진도 함께 올리는 경우 단독 사진에서만 이름을 분석하기 위한 분류다.
은행/금융앱 이체 화면이면 document_type="receipt", is_passport=false로 둔다.
화면의 가장 중요한 실제 송금액 문구를 통화 단위까지 그대로 displayed_amount_text에 적는다. 예: "40,000 KRW", "2,500.00 THB". 실제 송금 숫자는 amount_value에 넣고 currency는 KRW, THB, OTHER, UNKNOWN 중 하나로 구분한다.
통화 판정은 앱 언어, 태국어 문구, 사용자 국적, 앱 이름이 아니라 displayed_amount_text의 단위를 최우선으로 한다. 태국어 화면이어도 실제 송금액이 "40,000 KRW"이면 무조건 currency="KRW"이며 정상 원화 이체다. 수취인이 CHAYAPONE/Shinhan Bank/110551366954이고 송금액이 KRW이면 특히 원화 입금으로 판정한다. 수수료나 잔액의 통화가 아니라 실제 송금액의 통화를 사용한다.
실제 송금액 자체가 THB이고 태국 은행 사이에서 송금한 화면만 currency="THB", receipt_kind="thai_domestic_transfer"로 둔다. 예: Bangkok Bank 화면의 실제 송금액이 2,500.00 THB이면 displayed_amount_text="2,500.00 THB", amount_value=2500, amount_won=null이다. 한국 원화 송금이면 currency="KRW"로 두고 amount_won에도 원화 송금액을 넣는다. 태국 불기 연도 2569 또는 축약 연도 69는 서기 2026년으로 변환해 transfer_date에 기록한다.
둘 다 아니면 document_type="other", is_passport=false, is_transfer_receipt=false로 둔다.
모든 결과는 document_type, is_passport, is_transfer_receipt, surname, given_names, mrz_line1 필드를 포함한 JSON 하나로만 출력한다.
해당되지 않거나 화면에서 확인할 수 없는 문자열은 빈 문자열 또는 null, 금액은 null, all_names는 빈 배열, 점수는 0으로 반환한다.
passport이면 여권 이름 필드만 채우고 입금 관련 필드는 비운다. receipt이면 입금 관련 필드를 채우고 여권 이름 필드는 빈 문자열로 둔다. other이면 두 종류의 추출 필드를 모두 비운다.

${receiptSystemPrompt}`;

  const userPrompt = retry
    ? "같은 이미지를 한 번 더 재검토해줘. 1차에서 애매했더라도 실제 은행/간편송금 이체 완료 화면으로 보이고 실제 송금 금액이 읽히면 등록 버튼을 만들 수 있게 값을 추출해줘. 단, 일반 사진/공지/광고/연체 안내/채팅 캡처는 절대 통과시키지 마라. amount_won은 실제 상대방에게 송금/입금되는 순수 입금액만 넣고, 수수료/잔액/한도/날짜/연체료/수수료 포함 총 결제금액은 제외해줘. 송금액과 수수료/잔액이 따로 보이면 송금액만 amount_won으로 선택해줘. 잔액(ยอดเงินคงเหลือ/Balance/KRW 남은금액)은 절대 amount_won으로 쓰지 말고 balance_won에만 넣어줘. 화면에 보이는 모든 영문 이름을 역할과 관계없이 all_names에도 반드시 넣어줘. JSON 형식: {\"is_transfer_receipt\":true,\"amount_won\":60000,\"transfer_date\":\"2026-06-26 18:30\",\"sender_name\":null,\"recipient_name\":\"PUNNAPA KEEMNARAK\",\"displayed_self_name\":\"CHAYAPONE\",\"displayed_recipient_name\":\"PUNNAPA KEEMNARAK\",\"account_owner_name\":null,\"all_names\":[\"PUNNAPA KEEMNARAK\",\"CHAYAPONE\"],\"account_number\":\"110551366954\",\"confidence\":0.82,\"receipt_score\":85,\"reason\":\"재검토 근거\"}"
    : "이 이미지가 은행/간편송금 이체 캡처인지 먼저 판별하고, 맞을 때만 4가지를 분석해줘. 1) 실제 상대방에게 송금/입금되는 순수 입금액 amount_won, 2) 이체 날짜/시간 transfer_date, 3) 화면에 보이는 모든 이름을 sender_name, recipient_name, account_owner_name, displayed_self_name, displayed_recipient_name으로 역할별 분리하고 all_names 배열에도 전부 기록, 4) 계좌번호 account_number. 수수료가 포함된 총 결제금액/납부금액은 amount_won으로 쓰지 말고, 송금액과 수수료/잔액이 따로 보이면 송금액만 선택해줘. 잔액(ยอดเงินคงเหลือ/Balance/KRW 남은금액)은 절대 amount_won으로 쓰지 말고 balance_won에만 넣어줘. 계좌번호는 하이픈이 있어도 숫자만 account_number에 넣어줘. 날짜는 가능하면 YYYY-MM-DD HH:mm 형식으로 넣어줘. 확실하지 않거나 화면에 없으면 null. 일반 사진이나 이체와 관련 없는 이미지면 is_transfer_receipt=false, amount_won/transfer_date/account_number=null, all_names=[]로 반환해줘. 태국어 แสดงให้ผู้รับเห็น 옆 이름은 displayed_recipient_name, แสดงต่อตนเอง 옆 이름은 displayed_self_name으로 구분해줘. JSON 형식: {\"is_transfer_receipt\":true,\"amount_won\":60000,\"transfer_date\":\"2026-06-26 18:30\",\"sender_name\":null,\"recipient_name\":\"PUNNAPA KEEMNARAK\",\"displayed_self_name\":\"CHAYAPONE\",\"displayed_recipient_name\":\"PUNNAPA KEEMNARAK\",\"account_owner_name\":null,\"all_names\":[\"PUNNAPA KEEMNARAK\",\"CHAYAPONE\"],\"account_number\":\"110551366954\",\"confidence\":0.95,\"reason\":\"짧은 근거\"}";

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
              image_url: {
                url: `data:${image.contentType};base64,${image.base64}`,
                detail: "high"
              }
            }
          ]
        }
      ],
      max_completion_tokens: 300,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "line_image_analysis",
          strict: true,
          schema: {
            type: "object",
            properties: {
              document_type: { type: "string", enum: ["passport", "passport_selfie", "receipt", "other"] },
              currency: { type: "string", enum: ["KRW", "THB", "OTHER", "UNKNOWN"] },
              is_passport: { type: "boolean" },
              is_transfer_receipt: { type: "boolean" },
              mrz_line1: { type: "string" },
              surname: { type: "string" },
              given_names: { type: "string" },
              displayed_amount_text: { type: "string" },
              amount_value: { type: ["number", "null"] },
              amount_won: { type: ["number", "null"] },
              fee_won: { type: ["number", "null"] },
              balance_won: { type: ["number", "null"] },
              amount_role: { type: "string" },
              transfer_date: { type: ["string", "null"] },
              sender_name: { type: ["string", "null"] },
              recipient_name: { type: ["string", "null"] },
              displayed_self_name: { type: ["string", "null"] },
              displayed_recipient_name: { type: ["string", "null"] },
              account_owner_name: { type: ["string", "null"] },
              all_names: {
                type: "array",
                items: { type: "string" }
              },
              account_number: { type: ["string", "null"] },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              receipt_score: { type: "number", minimum: 0, maximum: 100 },
              receipt_kind: { type: "string" },
              reason: { type: "string" }
            },
            required: [
              "document_type",
              "currency",
              "is_passport",
              "is_transfer_receipt",
              "mrz_line1",
              "surname",
              "given_names",
              "displayed_amount_text",
              "amount_value",
              "amount_won",
              "fee_won",
              "balance_won",
              "amount_role",
              "transfer_date",
              "sender_name",
              "recipient_name",
              "displayed_self_name",
              "displayed_recipient_name",
              "account_owner_name",
              "all_names",
              "account_number",
              "confidence",
              "receipt_score",
              "receipt_kind",
              "reason"
            ],
            additionalProperties: false
          }
        }
      }
    })
  });

  const data = await response.json();
  if (!response.ok) {
    console.error("[RECEIPT OCR OPENAI FAIL]", data);
    return { ok: false, error: "⚠️ 이체사진 분석 중 오류가 발생했습니다." };
  }

  const content = data?.choices?.[0]?.message?.content || "";
  const parsed = parseJsonObjectLoose(content);
  const documentType = String(parsed?.document_type || "").trim().toLowerCase();

  // 얼굴+여권 인증사진은 이름 OCR 후보에서 제외한다.
  // 함께 올라온 여권 단독 사진만 queuePassportNameReply의 후보가 된다.
  if (documentType === "passport_selfie") {
    return {
      ok: false,
      ignored: true,
      kind: "passport_selfie",
      reason: "passport_selfie_ignored"
    };
  }

  const isPassport = documentType === "passport"
    || parsed?.is_passport === true
    || parsed?.is_passport === "true";

  if (isPassport) {
    const mrzName = parsePassportMrzNameLine(parsed?.mrz_line1 ?? parsed?.mrz_first_line);
    const surname = mrzName?.surname || normalizePassportNamePart(parsed?.surname);
    const givenNames = mrzName?.givenNames || normalizePassportNamePart(parsed?.given_names ?? parsed?.givenNames);
    const confidence = Number(parsed?.confidence ?? 0);

    if (surname && givenNames) {
      return {
        ok: true,
        kind: "passport",
        isPassport: true,
        surname,
        givenNames,
        fullName: `${givenNames} ${surname}`.replace(/\s+/g, " ").trim(),
        confidence: Number.isFinite(confidence) ? confidence : 0
      };
    }

    return {
      ok: false,
      kind: "passport",
      isPassport: true,
      reason: "passport_name_unclear",
      error: "⚠️ 여권 영문 이름을 확실하게 확인하지 못했습니다."
    };
  }

  const isTransferReceipt = parsed?.is_transfer_receipt === true || parsed?.is_transfer_receipt === "true";
  const modelCurrency = String(parsed?.currency || "UNKNOWN").trim().toUpperCase();
  const displayedAmountText = String(parsed?.displayed_amount_text || "").trim().toUpperCase();
  const explicitDisplayedCurrency = /(?:\bKRW\b|₩|원)/i.test(displayedAmountText)
    ? "KRW"
    : /(?:\bTHB\b|฿|บาท)/i.test(displayedAmountText)
      ? "THB"
      : "";
  const currency = explicitDisplayedCurrency || modelCurrency;
  const amountRole = String(parsed?.amount_role || parsed?.amount_type || "").trim().toLowerCase();
  const rawAmountValue = normalizeWonAmount(
    parsed?.amount_value
    ?? parsed?.transfer_amount_won
    ?? parsed?.sent_amount_won
    ?? parsed?.deposit_amount_won
    ?? parsed?.amount_won
  );
  const rawAmountWon = normalizeWonAmount(
    parsed?.transfer_amount_won
    ?? parsed?.sent_amount_won
    ?? parsed?.deposit_amount_won
    ?? parsed?.amount_won
    ?? (currency === "KRW" ? rawAmountValue : null)
  );
  const amountWon = normalizeReceiptDepositWonAmount(rawAmountWon);
  const feeWon = normalizeWonAmount(parsed?.fee_won ?? parsed?.charge_won);
  const balanceWon = normalizeWonAmount(parsed?.balance_won ?? parsed?.remaining_balance_won ?? parsed?.available_balance_won);
  const allNames = normalizeReceiptNameList(parsed);
  const senderName = selectExpectedReceiptName(allNames, parsed?.sender_name);
  const accountNumber = normalizeAccountNumber(parsed?.account_number);
  const transferDate = normalizeTransferDate(parsed?.transfer_date);
  const confidence = Number(parsed?.confidence ?? 0);
  const rawReceiptScore = Number(parsed?.receipt_score ?? NaN);
  const receiptScore = Number.isFinite(rawReceiptScore)
    ? rawReceiptScore
    : (Number.isFinite(confidence) ? confidence * 100 : 0);

  // 실제 송금액 단위가 THB일 때만 태국계좌 이체로 분류한다.
  // 태국어 UI나 receipt_kind만으로는 태국계좌 알림을 만들지 않는다.
  if (documentType === "receipt" && currency === "THB") {
    return {
      ok: false,
      kind: "thai_transfer",
      isTransferReceipt: true,
      currency: "THB",
      amountThb: rawAmountValue,
      displayedAmountText,
      senderName,
      allNames,
      recipientName: normalizeSenderName(parsed?.recipient_name),
      accountNumber,
      transferDate,
      receiptScore,
      reason: String(parsed?.reason || "thai_domestic_transfer").slice(0, 80),
      imageHash: image.sha256
    };
  }

  const expectedSenderMatched = allNames.some(name => isExpectedReceiptSender(name));
  const expectedAccountMatched = isExpectedReceiptAccount(accountNumber);
  // 이름이 표시되지 않는 이체 완료 화면도 있으므로, 등록된 수취계좌의 정확한 일치를 강한 단서로 인정한다.
  const hasExpectedReceiptClue = Boolean(expectedSenderMatched || expectedAccountMatched);
  // 모델 점수가 낮더라도 금액과 완료시각이 있고 등록된 수취계좌가 정확히 일치하면
  // Transaction result 같은 이름 없는 완료 화면을 정상 이체사진으로 보정한다.
  const effectiveIsTransferReceipt = Boolean(
    isTransferReceipt
    // 등록된 수취계좌가 정확히 보이면 완료시각 OCR이 빠져도 금액과 함께 강한 이체 증거다.
    || (expectedAccountMatched && rawAmountWon)
    // 계좌번호 대신 등록된 수취인명이 보이는 앱도 있으므로 금액+완료시각 조합을 허용한다.
    || (expectedSenderMatched && rawAmountWon && transferDate)
  );

  // 모니터 재촬영/반사/기울어짐 사진은 OCR 점수가 낮게 나올 수 있으므로
  // 실제 이체화면으로 판단되고 기대 계좌/예금주 단서가 있으면 점수 기준을 보정한다.
  if (!effectiveIsTransferReceipt || !Number.isFinite(receiptScore) || (receiptScore < RECEIPT_MIN_RECEIPT_SCORE && !hasExpectedReceiptClue)) {
    return {
      ok: false,
      ignored: true,
      kind: documentType === "other" ? "other" : "unknown",
      reason: retry ? "retry_not_receipt" : "not_receipt",
      isTransferReceipt,
      receiptScore: Number.isFinite(receiptScore) ? receiptScore : 0,
      confidence: Number.isFinite(confidence) ? confidence : 0,
      hasReceiptClue: Boolean(rawAmountWon || allNames.length || accountNumber || transferDate || hasExpectedReceiptClue)
    };
  }

  // 이름이 기대값과 다르더라도 자동으로 탈락시키지 않는다.
  // 등록 메시지에서 "⚠️ 확인 필요"로 표시하여 관리자가 사진을 직접 확인한다.
  if (RECEIPT_REQUIRE_EXPECTED_SENDER && allNames.length > 0 && !expectedSenderMatched) {
    console.log(`[RECEIPT OCR REVIEW] unexpected sender names=${allNames.join(", ")}`);
  }

  const hasStrongReceiptClue = Boolean(allNames.length || accountNumber || transferDate);
  const effectiveConfidence = Number.isFinite(confidence) ? confidence : 0;
  const retryPassByClue = retry && amountWon && (expectedSenderMatched || accountNumber || allNames.length);

  if (/fee|charge|수수료|total|pay|합계|총|ชำระ|ค่าธรรมเนียม|balance|remaining|available|잔액|남은|คงเหลือ|ยอดเงินคงเหลือ/.test(amountRole)) {
    return { ok: false, kind: "receipt", isTransferReceipt: true, error: "⚠️ 잔액/수수료/총액으로 보이는 금액은 자동 등록하지 않습니다. 실제 입금액을 확인 후 직접 코드/금액으로 등록해주세요.", reason: "amount_role_not_transfer" };
  }

  if (rawAmountWon && balanceWon && rawAmountWon === balanceWon && !parsed?.transfer_amount_won && !parsed?.sent_amount_won && !parsed?.deposit_amount_won) {
    return { ok: false, kind: "receipt", isTransferReceipt: true, error: "⚠️ 잔액으로 보이는 금액은 자동 등록하지 않습니다. 실제 입금액을 확인 후 직접 코드/금액으로 등록해주세요.", reason: "amount_is_balance" };
  }

  if (rawAmountWon && feeWon && rawAmountWon === feeWon && !parsed?.transfer_amount_won && !parsed?.sent_amount_won && !parsed?.deposit_amount_won) {
    return { ok: false, kind: "receipt", isTransferReceipt: true, error: "⚠️ 수수료로 보이는 금액은 자동 등록하지 않습니다. 실제 입금액을 확인 후 직접 코드/금액으로 등록해주세요.", reason: "amount_is_fee" };
  }

  if (!amountWon || (effectiveConfidence < RECEIPT_MIN_CONFIDENCE && !hasStrongReceiptClue && !retryPassByClue)) {
    return { ok: false, kind: "receipt", isTransferReceipt: true, error: "⚠️ 이체금액을 확실하게 확인하지 못했습니다. 직접 코드/금액으로 등록해주세요.", reason: retry ? "retry_amount_unclear" : "amount_unclear" };
  }

  const sheetValue = convertWonToSheetInputValue(amountWon);
  if (!sheetValue) {
    return { ok: false, kind: "receipt", isTransferReceipt: true, error: "⚠️ 이체금액 변환에 실패했습니다. 직접 코드/금액으로 등록해주세요.", reason: "convert_failed" };
  }

  return {
    ok: true,
    kind: "receipt",
    amountWon,
    sheetValue,
    senderName,
    allNames,
    recipientName: normalizeSenderName(parsed?.recipient_name),
    displayedSelfName: normalizeSenderName(parsed?.displayed_self_name),
    displayedRecipientName: normalizeSenderName(parsed?.displayed_recipient_name),
    accountOwnerName: normalizeSenderName(parsed?.account_owner_name),
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

  // 비용 예측이 가능하도록 이미지당 OpenAI 호출은 항상 1회로 제한한다.
  // 판독이 어려운 여권/입금사진은 호출을 반복하지 않고 PP01 관리자방에 알린다.
  return result;
}


function buildReceiptCustomerAnalysisText({ code, amountWon, sheetValue, senderName, accountNumber, transferDate }) {
  return [
    buildReceiptAnalysisText({
      code,
      amountWon,
      sheetValue,
      senderName,
      accountNumber,
      transferDate,
      includePrompt: false
    }),
    "",
    "관리자 확인방으로 등록 요청을 보냈습니다."
  ].join("\n");
}

function buildReceiptApprovalFlexMessage({ code, amountWon, sheetValue, senderName, accountNumber, transferDate, dataBase }) {
  const amountText = Number(amountWon).toLocaleString("ko-KR");
  const reviewText = buildReceiptMatchText({ senderName, accountNumber }).split("\n");
  const fields = [
    `코드 : ${code}`,
    `입금액 : ${amountText}원`,
    `시트값 : ${sheetValue}`,
    `입금자 : ${senderName || "-"}`,
    `계좌 : ${accountNumber || "-"}`,
    `이체일시 : ${transferDate || "-"}`,
    ...reviewText
  ];

  return {
    type: "flex",
    altText: `입금 등록 대기: ${code} / ${amountText}원`,
    contents: {
      type: "bubble",
      size: "mega",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          { type: "text", text: `📥 ${RECEIPT_APPROVAL_GROUP_CODE} 입금 등록 대기`, weight: "bold", size: "md", wrap: true },
          { type: "separator", margin: "md" },
          ...fields.map((text, idx) => ({ type: "text", text, size: "sm", wrap: true, margin: idx === 0 ? "md" : "none" })),
          { type: "text", text: "입금 등록하시겠습니까?", weight: "bold", size: "sm", wrap: true, margin: "md" }
        ]
      },
      footer: {
        type: "box",
        layout: "horizontal",
        spacing: "sm",
        contents: [
          { type: "button", style: "primary", height: "sm", action: { type: "postback", label: "등록", data: `${dataBase}&action=confirm`, displayText: "등록" } },
          { type: "button", style: "secondary", height: "sm", action: { type: "postback", label: "취소", data: `${dataBase}&action=cancel`, displayText: "취소" } }
        ]
      }
    }
  };
}

function buildReceiptConfirmMessages({ code, amountWon, sheetValue, senderName, accountNumber, transferDate, receiptKey, sourceGroupId, pendingId, approvalNotice = false }) {
  // LINE postback data는 길이 제한이 있어 입금자/계좌/날짜 같은 표시용 값은 버튼 data에서 제외한다.
  // 특히 PP01방에서 누를 때 원본 고객방 sourceGroupId가 잘리지 않도록 필수값만 담는다.
  const dataBase = `receipt=1&pid=${encodeURIComponent(pendingId || "")}&key=${encodeURIComponent(receiptKey || "")}&code=${encodeURIComponent(code)}&value=${encodeURIComponent(sheetValue)}&won=${encodeURIComponent(amountWon)}&source=${encodeURIComponent(sourceGroupId || "")}`;

  if (approvalNotice) {
    return [buildReceiptApprovalFlexMessage({
      code,
      amountWon,
      sheetValue,
      senderName,
      accountNumber,
      transferDate,
      dataBase
    })];
  }

  // 고객그룹방에는 등록/취소 버튼을 노출하지 않고 분석 결과만 보여준다.
  return [buildTextMessage(buildReceiptCustomerAnalysisText({
    code,
    amountWon,
    sheetValue,
    senderName,
    accountNumber,
    transferDate
  }))];
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
${formatWon(receipt.won)} รับโอนเรียบร้อย

(${getKoreaDateTimeText()})`;
}

function buildReceiptDoneFlexMessage(receipt, dateTimeText = getKoreaDateTimeText()) {
  const codeText = `${receipt.code}/${receipt.value}`;
  const amountText = formatWon(receipt.won);

  return {
    type: "flex",
    altText: `✅ ${codeText} ${amountText} 입금 확인 완료`,
    contents: {
      type: "bubble",
      size: "kilo",
      body: {
        type: "box",
        layout: "vertical",
        alignItems: "center",
        spacing: "md",
        paddingAll: "24px",
        contents: [
          {
            type: "text",
            text: "✅",
            size: "5xl",
            align: "center"
          },
          {
            type: "text",
            text: "รับโอนเรียบร้อย",
            weight: "bold",
            size: "lg",
            align: "center",
            wrap: true
          },
          {
            type: "text",
            text: "입금 확인 완료",
            size: "sm",
            color: "#888888",
            align: "center",
            wrap: true
          },
          {
            type: "separator",
            margin: "lg"
          },
          {
            type: "box",
            layout: "vertical",
            spacing: "sm",
            margin: "lg",
            width: "100%",
            contents: [
              {
                type: "text",
                text: `👤 ${codeText}`,
                size: "md",
                weight: "bold",
                color: "#333333",
                align: "center",
                wrap: true
              },
              {
                type: "text",
                text: `💰 ${amountText}`,
                size: "md",
                weight: "bold",
                color: "#333333",
                align: "center",
                wrap: true
              },
              {
                type: "text",
                text: `🕒 ${dateTimeText}`,
                size: "sm",
                color: "#888888",
                align: "center",
                wrap: true
              }
            ]
          }
        ]
      }
    }
  };
}

function buildReceiptDoneMessages(receipt) {
  return [buildReceiptDoneFlexMessage(receipt)];
}

async function pushReceiptDoneToRelatedGroups({ clickedGroupId, sourceGroupId, approvalGroupId, messages }) {
  const targets = new Set([sourceGroupId, approvalGroupId].filter(Boolean));
  if (clickedGroupId) targets.delete(clickedGroupId);

  const failures = [];
  for (const targetGroupId of targets) {
    try {
      await pushToLineMessages(targetGroupId, messages);
    } catch (err) {
      const errorText = getLinePushErrorMessage(err);
      failures.push(`${targetGroupId}: ${errorText}`);
      console.error(`[RECEIPT DONE PUSH FAIL] targetGroupId=${targetGroupId} error=${errorText}`);
    }
  }
  return failures;
}


async function notifyReceiptAnalysisFailureToApprovalGroup({ accessToken, sourceGroupId, code, messageId, error, title, detail, replyToken }) {
  try {
    const approvalGroupId = await getReceiptApprovalGroupId(accessToken);
    if (!approvalGroupId) {
      console.warn(`[RECEIPT OCR FAIL NOTICE SKIP] approvalGroupId=${approvalGroupId || "not_found"} sourceGroupId=${sourceGroupId}`);
      return;
    }

    const safeError = String(error || "분석 결과를 확정하지 못했습니다.").slice(0, 500);
    const noticeText = [
      title || "⚠️ 이체사진 분석 실패",
      "",
      `고객방 코드: ${code || "-"}`,
      `고객방 ID: ${sourceGroupId || "-"}`,
      `메시지 ID: ${messageId || "-"}`,
      `사유: ${safeError}`,
      "",
      detail || "1회 분석으로 내용을 확정하지 못해 등록 버튼을 만들지 않았습니다.",
      "고객방의 원본 이미지를 직접 확인해주세요.",
      "",
      `(${getKoreaDateTimeText()})`
    ].join("\n");

    // PP01 관리자방에서 사진을 직접 시험하면 원본방과 알림방이 같다.
    // 이 경우 중복 방지로 버리지 않고, 해당 이미지 이벤트의 replyToken으로 같은 방에 답장한다.
    if (approvalGroupId === sourceGroupId) {
      if (replyToken) {
        await replyToLine(replyToken, noticeText);
      } else {
        console.warn(`[RECEIPT OCR FAIL NOTICE SAME GROUP SKIP] approvalGroupId=${approvalGroupId} replyToken=missing`);
      }
      return;
    }

    await pushToLine(approvalGroupId, noticeText);
  } catch (err) {
    const errorText = getLinePushErrorMessage(err);
    console.error(`[RECEIPT OCR FAIL NOTICE PUSH FAIL] code=${code || "-"} sourceGroupId=${sourceGroupId || "-"} error=${errorText}`);
  }
}


function normalizePassportNamePart(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z' -]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function removePassportNameTitle(value) {
  return normalizePassportNamePart(value)
    .replace(/^(?:MR|MRS|MISS|MS|MASTER|DR)\.?\s+/i, "")
    .trim();
}

function buildPassportFullName(givenNames, surname) {
  const given = removePassportNameTitle(givenNames);
  const family = normalizePassportNamePart(surname);
  if (!given || !family) return "";
  return `${given} ${family}`.replace(/\s+/g, " ").trim();
}

// TD3 여권 MRZ 첫 줄 예시: P<THATHAMWONGSRI<<PANNAPA<<<<<<<<<<<<
// P< 다음 3글자(THA)는 발급국 코드이며 성명에 포함하지 않는다.
function parsePassportMrzNameLine(value) {
  const line = String(value || "")
    .toUpperCase()
    .replace(/[^A-Z<]/g, "")
    .trim();

  const match = line.match(/^P<([A-Z<]{3})(.+)$/);
  if (!match) return null;

  const issuingCountryCode = match[1].replace(/</g, "");
  const nameArea = match[2];
  const separatorIndex = nameArea.indexOf("<<");
  if (separatorIndex < 1) return null;

  const surname = normalizePassportNamePart(
    nameArea.slice(0, separatorIndex).replace(/</g, " ")
  );
  const givenNames = normalizePassportNamePart(
    nameArea.slice(separatorIndex + 2).replace(/<+/g, " ")
  );

  if (!surname || !givenNames) return null;
  return { issuingCountryCode, surname, givenNames };
}

async function callPassportOcrOpenAI(image) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: PASSPORT_OCR_MODEL,
      messages: [
        {
          role: "system",
          content: "너는 여권 이미지 판별 및 영문 성명 OCR 분석기다. 실제 여권의 인적사항면 또는 여권 하단 MRZ가 확인되면 is_passport=true로 판단한다. 오직 Surname(성)과 Given names(이름)만 읽고, 여권번호·생년월일·국적·성별·만료일 등 다른 개인정보는 추출하거나 출력하지 않는다. 먼저 MRZ가 이미지에 실제로 포함되어 있고 충분히 선명한지 확인한다. MRZ 첫 줄을 선명하게 읽을 수 있으면 글자 단위로 읽고 인적사항의 Surname/Given names와 교차검증하며, 두 영역이 다르면 MRZ를 우선한다. MRZ가 사진 밖으로 잘렸거나 가려졌거나 흐려서 확실히 읽을 수 없는 경우에는 mrz_line1을 빈 문자열로 두고, 인적사항 영역에 인쇄된 Surname과 Given names 또는 Name을 직접 읽는다. MRZ가 없다는 이유만으로 읽을 수 있는 인적사항 이름을 빈 값으로 만들거나 is_passport=false로 판단하지 않는다. MR, MRS, MISS, MS, MASTER, DR 같은 호칭은 이름이 아니므로 given_names에서 반드시 제외한다. 이름을 자연스러운 철자나 실제 존재할 법한 이름으로 추측·보정·확장하지 말고 이미지에 인쇄된 영문자만 그대로 옮긴다. TD3 MRZ 첫 줄 형식은 P<국가코드3글자성<<이름이다. 태국 여권은 P<THA로 시작하며 THA는 발급국 코드이지 성명의 일부가 아니다. P<와 그 직후 국가코드 3글자를 제거한 다음 첫 번째 << 앞을 성, 뒤를 이름으로 읽는다. mrz_line1에는 선명하게 보이는 경우에만 MRZ 첫 줄을 공백 없이 대문자로 그대로 반환한다. 결과 이름은 여권 표기 철자 그대로 대문자로 반환한다. 이미지가 여권이 아니거나 인적사항과 MRZ 양쪽 모두에서 이름을 확실히 읽을 수 없을 때만 이름을 빈 값으로 둔다."
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "이 이미지가 여권인지 판별하고 성과 이름만 추출해줘. 선명한 MRZ 첫 줄이 있으면 우선 사용하되, MRZ가 잘렸거나 없으면 인적사항의 Surname과 Given names/Name을 사용해라. MR/MRS/MISS/MS 등의 호칭은 제외하고 철자를 추측하지 마라. 최종 표시는 Given names + 공백 1개 + Surname 순서다."
            },
            {
              type: "image_url",
              image_url: {
                url: `data:${image.contentType};base64,${image.base64}`,
                detail: "auto"
              }
            }
          ]
        }
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "passport_name_result",
          strict: true,
          schema: {
            type: "object",
            properties: {
              is_passport: { type: "boolean" },
              mrz_line1: { type: "string" },
              surname: { type: "string" },
              given_names: { type: "string" },
              confidence: { type: "number", minimum: 0, maximum: 1 }
            },
            required: ["is_passport", "mrz_line1", "surname", "given_names", "confidence"],
            additionalProperties: false
          }
        }
      },
      max_completion_tokens: 220
    })
  });

  const data = await response.json();
  if (!response.ok) {
    console.error("[PASSPORT OCR OPENAI FAIL]", data);
    return { ok: false, isPassport: false };
  }

  const parsed = parseJsonObjectLoose(data?.choices?.[0]?.message?.content || "");
  const isPassport = parsed?.is_passport === true || parsed?.is_passport === "true";
  const mrzName = parsePassportMrzNameLine(parsed?.mrz_line1 ?? parsed?.mrz_first_line);
  // MRZ가 정상 파싱되면 인쇄 영역 OCR보다 우선하여 국가코드(예: THA) 혼입을 방지한다.
  const surname = mrzName?.surname || normalizePassportNamePart(parsed?.surname);
  const givenNames = removePassportNameTitle(
    mrzName?.givenNames || parsed?.given_names || parsed?.given_name
  );
  const confidence = Number(parsed?.confidence || 0);
  const fullName = buildPassportFullName(givenNames, surname);

  if (!isPassport || !fullName || confidence < 0.55) {
    return { ok: true, isPassport: false };
  }

  return { ok: true, isPassport: true, surname, givenNames, fullName, confidence };
}

function cleanupPassportBatchCache(now = Date.now()) {
  for (const [key, item] of passportBatchCache.entries()) {
    if (Number(item?.expiresAt || 0) <= now) passportBatchCache.delete(key);
  }
}

async function queuePassportNameReply(event, passportResult) {
  const sourceId = getLineSourceGroupId(event) || event?.source?.userId || "";
  if (!sourceId) return;

  const now = Date.now();
  cleanupPassportBatchCache(now);
  const previous = passportBatchCache.get(sourceId) || { generation: 0, candidates: [] };
  const generation = Number(previous.generation || 0) + 1;
  const candidates = [...(previous.candidates || []), passportResult]
    .filter(item => item?.fullName)
    .slice(-2);

  passportBatchCache.set(sourceId, {
    generation,
    candidates,
    expiresAt: now + PASSPORT_BATCH_TTL_MS
  });

  // 고객이 여권을 1장 또는 2장 연속으로 보낼 수 있으므로 잠깐 모은 뒤,
  // 가장 신뢰도가 높은 영문 이름 하나만 최종 메시지로 보낸다.
  await new Promise(resolve => setTimeout(resolve, PASSPORT_BATCH_WAIT_MS));

  const latest = passportBatchCache.get(sourceId);
  if (!latest || latest.generation !== generation) return;

  const best = [...latest.candidates].sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))[0];
  passportBatchCache.delete(sourceId);
  if (!best?.fullName) return;

  await pushToLine(sourceId, best.fullName);
}

async function tryHandlePassportImage(event) {
  if (!process.env.OPENAI_API_KEY) return false;

  try {
    const image = await downloadLineMessageContent(event.message.id);
    const result = await callPassportOcrOpenAI(image);
    if (!result?.isPassport) return false;
    await queuePassportNameReply(event, result);
    return true;
  } catch (err) {
    console.error(`[PASSPORT IMAGE HANDLE FAIL] messageId=${event.message?.id || "-"} error=${err?.message || err}`);
    return false;
  }
}

async function handleReceiptImageMessage(event, analyzedResult = null, sourceContext = null) {
  const sourceGroupId = getLineSourceGroupId(event);
  if (!sourceGroupId) return;

  // 이미지가 올라온 순간 확인한 고객방 정보를 이후 분석 성공/실패 분기에서도 그대로 사용한다.
  // OCR이 끝난 뒤 다시 매핑을 조회해서 코드가 "-"로 바뀌는 일을 막기 위한 처리다.
  let accessToken = sourceContext?.accessToken || null;
  let code = String(sourceContext?.code || "").trim().toUpperCase();

  try {
    if (!SHEET_ID) {
      console.error("[RECEIPT IMAGE SKIP] GOOGLE_SHEET_ID is not set");
      return;
    }

    // 사진이 올라오면 먼저 이체/입금 슬립인지 판별한다.
    // 일반 생활사진/상품사진/캡처는 result.ignored=true로 끝내고, 고객방/관리자방 모두 아무 메시지도 보내지 않는다.
    const result = analyzedResult || await analyzeReceiptImageAmount(event.message.id);

    if (result.kind === "thai_transfer") {
      if (!accessToken) accessToken = await getGoogleAccessToken();
      if (!code) code = await findMappedCodeByGroupId(accessToken, sourceGroupId);

      const amountText = Number.isFinite(result.amountThb)
        ? `${Number(result.amountThb).toLocaleString("ko-KR")} THB`
        : "확인 불가";

      await notifyReceiptAnalysisFailureToApprovalGroup({
        accessToken,
        sourceGroupId,
        code: code || "-",
        messageId: event.message.id,
        title: "🇹🇭 태국계좌 이체 사진",
        error: "실제 송금액이 태국 바트(THB)인 계좌 이체로 확인되어 자동 등록하지 않았습니다.",
        detail: `송금금액: ${amountText}\n이체일시: ${result.transferDate || "확인 불가"}\n등록 버튼은 생성하지 않았습니다.`,
        replyToken: event.replyToken
      });
      return;
    }

    if (!result.ok) {
      if (result.ignored) return;

      if (result.kind !== "receipt" && result.kind !== "passport") return;

      if (!accessToken) accessToken = await getGoogleAccessToken();
      if (!code) code = await findMappedCodeByGroupId(accessToken, sourceGroupId);
      await notifyReceiptAnalysisFailureToApprovalGroup({
        accessToken,
        sourceGroupId,
        code: code || "-",
        messageId: event.message.id,
        title: result.kind === "passport"
          ? "⚠️ 여권 영문 분석 실패"
          : "⚠️ 이체사진 분석 실패",
        error: result.error || result.reason,
        detail: result.kind === "passport"
          ? "1회 분석으로 여권 영문 이름을 확정하지 못했습니다."
          : "1회 분석으로 내용을 확정하지 못해 등록 버튼을 만들지 않았습니다.",
        replyToken: event.replyToken
      });
      // 고객방에는 실패 메시지를 보내지 않는다. 관리자방 알림만 남긴다.
      return;
    }

    if (!accessToken) accessToken = await getGoogleAccessToken();
    if (!code) code = await findMappedCodeByGroupId(accessToken, sourceGroupId);
    if (!code) {
      // 실제 이체사진으로 판별된 경우에만 코드 매핑 누락을 PP01 관리자방에 알린다.
      // 일반 사진은 위에서 이미 조용히 무시된다.
      await notifyReceiptAnalysisFailureToApprovalGroup({
        accessToken,
        sourceGroupId,
        code: "-",
        messageId: event.message?.id,
        title: "⚠️ 이체사진 분석 불가",
        error: "해당 고객방의 코드 매핑을 찾지 못했습니다.",
        detail: "이체사진으로 보이지만 코드/등록이 안 된 고객방이거나 그룹 매핑이 삭제된 상태입니다. 고객방 매핑을 먼저 확인해주세요.",
        replyToken: event.replyToken
      });
      return;
    }

    const imageKey = buildReceiptImageKey({ sourceGroupId, imageHash: result.imageHash });
    const infoKey = buildReceiptInfoKey({
      sourceGroupId,
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

    let existing = receiptCacheGet(imageKey) || receiptCacheGet(infoKey) || receiptCacheGet(nearDuplicateKey);
    if (!existing) {
      try {
        // Vercel/서버리스 환경에서는 연속 이미지가 서로 다른 인스턴스에서 처리될 수 있어
        // 메모리 캐시만으로는 같은 입금내역 중복 버튼을 막지 못한다.
        // LINE등록대기 시트에 저장된 이미지키/정보키/유사키까지 확인해서
        // 위/아래로 나눠 보낸 같은 입금 캡처는 버튼과 PP01 푸시를 다시 만들지 않는다.
        existing = await findReceiptDuplicatePendingByKeys(accessToken, {
          imageKey,
          infoKey,
          nearDuplicateKey
        });
        if (existing) {
          receiptCacheSet(imageKey, existing);
          receiptCacheSet(infoKey, existing);
          receiptCacheSet(nearDuplicateKey, existing, RECEIPT_NEAR_DUPLICATE_TTL_MS);
          receiptCacheSet(existing.pendingId, existing);
        }
      } catch (err) {
        console.error(`[RECEIPT DUPLICATE SHEET CHECK FAIL] code=${code} error=${err?.response?.data?.error?.message || err?.message || err}`);
      }
    }

    if (existing) {
      // 같은 송금내역을 스크롤해서 위/아래 2장으로 보낸 경우에는
      // 등록 버튼과 PP01 푸시를 다시 만들지 않고 PP01에 이미 생성된 기존 요청만 사용하게 한다.
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

    // 고객방에는 분석 메시지만 보여주고, PP01 관리자 확인방에는 분석 내용과 등록 버튼이 합쳐진 카드 1개만 보낸다.
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
  } catch (err) {
    const errorText = getLinePushErrorMessage(err);
    console.error(`[RECEIPT IMAGE HANDLE FAIL] code=${code || "-"} sourceGroupId=${sourceGroupId || "-"} messageId=${event.message?.id || "-"} error=${errorText}`);

    try {
      if (!accessToken) accessToken = await getGoogleAccessToken();
      await notifyReceiptAnalysisFailureToApprovalGroup({
        accessToken,
        sourceGroupId,
        code: code || "-",
        messageId: event.message?.id,
        title: "⚠️ 이체사진 처리 오류",
        error: errorText,
        detail: "이미지 수신/OCR/등록대기 생성 과정에서 오류가 발생해서 등록 버튼을 만들지 못했습니다.",
        replyToken: event.replyToken
      });
    } catch (noticeErr) {
      console.error(`[RECEIPT IMAGE HANDLE FAIL NOTICE ERROR] ${noticeErr?.message || noticeErr}`);
    }

    // 고객방에는 실패 메시지를 보내지 않는다.
  }
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
      if (["pending", "processing"].includes(String(status).toLowerCase())) {
        receiptCacheSet(cached.nearDuplicateKey, { ...cached, status }, RECEIPT_NEAR_DUPLICATE_TTL_MS);
      } else if (cached.nearDuplicateKey) {
        receiptDuplicateCache.delete(cached.nearDuplicateKey);
      }
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
      await retryPendingStatusUpdate(() => updateReceiptPendingStatus(accessToken, pending, status), `RECEIPT PENDING STATUS FAIL pendingId=${receipt.pendingId} status=${status}`);
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
  const doneMessages = buildReceiptDoneMessages(receipt);
  const approvalGroupId = cached?.approvalGroupId || (SHEET_ID ? await getReceiptApprovalGroupId(accessToken) : null);
  const sourceGroupId = cached?.sourceGroupId || pending?.sourceGroupId || receipt.sourceGroupId;

  await replyToLineMessages(event.replyToken, doneMessages);
  const pushFailures = await pushReceiptDoneToRelatedGroups({
    clickedGroupId,
    sourceGroupId,
    approvalGroupId,
    messages: doneMessages
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

async function pushToLineWithRetry(code, groupId, message) {
  let lastError = null;
  const retrySource = typeof message === "string" ? message : JSON.stringify(message);
  const retryKey = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : crypto.createHash("sha256").update(`${Date.now()}:${code}:${groupId}:${retrySource}`).digest("hex").slice(0, 36);

  for (let attempt = 1; attempt <= LINE_PUSH_RETRY_COUNT + 1; attempt += 1) {
    try {
      if (typeof message === "string") {
        await pushToLine(groupId, message, retryKey);
      } else {
        await pushToLineMessages(groupId, [message], retryKey);
      }
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
  const clean = normalizeText(normalizeEnglishKeyboardCommand(text)).replace(/\s+/g, "");
  const match = clean.match(/^(오늘상환요청|오늘상환오전|오늘상환오후)(?:\/([A-Za-z0-9가-힣_-]{1,10}))?$/);

  if (!match) {
    return null;
  }

  const command = match[1];
  const codePrefix = match[2] ? match[2].trim().toUpperCase() : "";

  if (command === "오늘상환요청") {
    return { type: "payment", message: buildPaymentRequestFlexMessage(), codePrefix };
  }

  if (command === "오늘상환오전") {
    return { type: "morning", message: REPAYMENT_MORNING_MESSAGE, codePrefix };
  }

  if (command === "오늘상환오후") {
    return { type: "afternoon", message: REPAYMENT_AFTERNOON_MESSAGE, codePrefix };
  }

  return null;
}

function parseTodayRepaymentTestCommand(text) {
  const clean = normalizeText(normalizeEnglishKeyboardCommand(text)).replace(/\s+/g, "");
  return clean === "오늘상환요청테스트";
}

function buildRepaymentAdminResultFlexMessage(resultText) {
  const lines = String(resultText || "").split("\n");
  const title = lines.shift() || "상환 요청 발송 결과";
  const rawDetail = lines.join("\n").trim() || "처리 결과가 없습니다.";
  const detail = rawDetail.length > 1900 ? `${rawDetail.slice(0, 1880)}\n…(일부 생략)` : rawDetail;
  const isFailure = title.startsWith("❌");
  const isWarning = title.startsWith("⚠️");
  const headerColor = isFailure ? "#B42318" : isWarning ? "#B54708" : "#027A48";

  return {
    type: "flex",
    altText: String(resultText || "상환 요청 발송 결과").slice(0, 1500),
    contents: {
      type: "bubble",
      size: "kilo",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: headerColor,
        paddingAll: "18px",
        contents: [
          { type: "text", text: title, color: "#FFFFFF", size: "md", weight: "bold", wrap: true }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "18px",
        spacing: "md",
        contents: [
          { type: "text", text: detail, color: "#344054", size: "sm", wrap: true },
          { type: "separator", color: "#E4E7EC", margin: "md" },
          { type: "text", text: `처리 시각  ${getKoreaDateTimeText()}`, color: "#667085", size: "xs", wrap: true, margin: "md" }
        ]
      }
    }
  };
}

function parseUnregisteredCheckCommand(text) {
  const clean = normalizeText(normalizeEnglishKeyboardCommand(text)).replace(/\s+/g, "");
  return clean === "미등록";
}

// PP01 관리자 확인방에서 등록 버튼을 아직 누르지 않은 대기 항목 조회
function parsePendingRegistrationCheckCommand(text) {
  const clean = normalizeText(normalizeEnglishKeyboardCommand(text)).replace(/\s+/g, "");
  return clean === "/미등록";
}

function parseMyIdCommand(text) {
  const clean = normalizeText(normalizeEnglishKeyboardCommand(text)).replace(/\s+/g, "");
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

async function buildCustomerCreditReports(command) {
  if (!SHEET_ID) {
    return ["⚠️ GOOGLE_SHEET_ID 환경변수가 설정되지 않았습니다."];
  }

  const accessToken = await getGoogleAccessToken();
  const values = await getSheetValues(accessToken);
  return buildCustomerCreditReportsFromValues(command, values);
}

function buildCustomerCreditReportsFromValues(command, values) {
  const records = findCreditRecords(values, command);

  if (records.length || command.type === "code") {
    const reports = [buildCreditReply(command, records)];

    // 코드로 조회하면 가장 최근 거래의 고객 영문명을 이용해 이름 조회를 한 번 더 실행한다.
    // 같은 고객이 과거에 다른 코드를 사용한 경우까지 두 번째 푸시에서 함께 확인할 수 있다.
    if (command.type === "code" && records.length) {
      const customerName = records
        .slice()
        .sort((a, b) =>
          ((b.loanDateValue || 0) - (a.loanDateValue || 0))
          || ((b.rowNumber || 0) - (a.rowNumber || 0))
        )
        .find(record => normalizeText(record.customerName))
        ?.customerName;

      if (customerName) {
        const nameCommand = { type: "name", keyword: normalizeText(customerName) };
        const nameRecords = findCreditRecords(values, nameCommand);
        reports.push(`🔎 자동 영문이름 조회\n\n${buildCreditReply(nameCommand, nameRecords)}`);
      }
    }

    return reports;
  }

  const candidates = findSimilarCustomerCandidates(values, command.keyword);
  return [buildSimilarCustomerReply(command.keyword, candidates)];
}

function getCustomerRiskLookupTargets(command, customerValues) {
  const directRecords = findCreditRecords(customerValues, command);
  const relatedRecords = [...directRecords];
  const names = new Set();
  const codes = new Set();

  if (command.type === "code") codes.add(command.keyword);
  else names.add(normalizeText(command.keyword));

  for (const record of directRecords) {
    if (record.code) codes.add(record.code);
    if (normalizeText(record.customerName)) names.add(normalizeText(record.customerName));
  }

  // 코드 조회인 경우 같은 영문 이름으로 등록된 과거/다른 코드도 함께 연결한다.
  if (command.type === "code" && names.size) {
    for (const name of names) {
      const nameRecords = findCreditRecords(customerValues, { type: "name", keyword: name });
      for (const record of nameRecords) relatedRecords.push(record);
    }
  }

  for (const record of relatedRecords) {
    if (record.code) codes.add(record.code);
    if (normalizeText(record.customerName)) names.add(normalizeText(record.customerName));
  }

  return {
    codes,
    names,
    displayName: [...names][0] || command.keyword
  };
}

function messageMentionsCustomerName(messageText, customerName) {
  const source = normalizeText(messageText)
    .toLowerCase()
    .replace(/[^a-z0-9가-힣\u0E00-\u0E7F]/g, "");
  if (!source) return false;

  for (const variant of getCustomerNameSearchVariants(customerName)) {
    const cleanVariant = String(variant || "").replace(/[^a-z0-9가-힣\u0E00-\u0E7F]/g, "");
    if (cleanVariant && source.includes(cleanVariant)) return true;
  }
  return false;
}

function findCustomerRiskMentions(command, customerValues, riskLogValues) {
  const targets = getCustomerRiskLookupTargets(command, customerValues);
  const matches = [];
  const seen = new Set();

  for (let i = 1; i < (riskLogValues || []).length; i += 1) {
    const row = riskLogValues[i] || [];
    const recordId = String(row[0] || row[7] || `${i}`);
    const occurredAt = String(row[1] || "날짜없음");
    const groupId = String(row[2] || "");
    const groupCode = String(row[3] || "").trim().toUpperCase();
    const keywords = String(row[5] || "").trim();
    const originalText = String(row[6] || "");
    const timestamp = Number(row[8]) || 0;

    if (!keywords) continue;
    const matchedByCode = Boolean(groupCode && targets.codes.has(groupCode));
    const matchedByName = [...targets.names].some(name => messageMentionsCustomerName(originalText, name));
    if (!matchedByCode && !matchedByName) continue;
    if (seen.has(recordId)) continue;
    seen.add(recordId);

    matches.push({ recordId, occurredAt, groupId, groupCode, keywords, originalText, timestamp });
  }

  return {
    targets,
    matches: matches.sort((a, b) => b.timestamp - a.timestamp)
  };
}

function buildCustomerRiskReportFromValues(command, customerValues, riskLogValues) {
  const { targets, matches } = findCustomerRiskMentions(command, customerValues, riskLogValues);
  const title = "🔎 대화 위험 키워드 조회";
  const nameLine = `고객명: ${targets.displayName || command.keyword}`;

  if (!matches.length) {
    return `${title}\n\n${nameLine}\n관련 기록 없음\n\n※ 기능 적용 이후 기록만 조회됩니다.`;
  }

  const visible = matches.slice(0, CHAT_RISK_RESULT_LIMIT);
  const lines = visible.map(item => {
    const code = item.groupCode ? ` / ${item.groupCode}` : "";
    const referencedDates = extractReferencedDateTokens(item.originalText);
    const referencedDateText = referencedDates.length
      ? ` / 기재일 ${referencedDates.join(", ")}`
      : "";
    return `${item.occurredAt}${code} / ${item.keywords}${referencedDateText}`;
  });
  const remainder = matches.length > visible.length
    ? `\n외 ${matches.length - visible.length}건`
    : "";

  return `${title}\n\n${nameLine}\n총 ${matches.length}건\n\n${lines.join("\n")}${remainder}\n\n※ 기능 적용 이후 기록만 조회됩니다.`;
}

async function buildCustomerCreditLookup(command) {
  if (!SHEET_ID) {
    return {
      creditReplies: ["⚠️ GOOGLE_SHEET_ID 환경변수가 설정되지 않았습니다."],
      riskReply: null
    };
  }

  const accessToken = await getGoogleAccessToken();
  const customerValues = await getSheetValues(accessToken);
  const creditReplies = buildCustomerCreditReportsFromValues(command, customerValues);

  try {
    const riskLogValues = await getChatRiskLogValues(accessToken);
    return {
      creditReplies,
      riskReply: buildCustomerRiskReportFromValues(command, customerValues, riskLogValues)
    };
  } catch (err) {
    console.error(`[CHAT RISK LOOKUP FAIL] keyword=${command.keyword} error=${err?.response?.data?.error?.message || err?.message || err}`);
    return {
      creditReplies,
      riskReply: "⚠️ 대화 위험 키워드 기록을 조회하지 못했습니다. 잠시 후 다시 시도해주세요."
    };
  }
}

function hasDollarToday(values, topIndex0, todayColumnIndex0) {
  const topRow = values[topIndex0] || [];
  const bottomRow = values[topIndex0 + 1] || [];
  const topToday = String(topRow[todayColumnIndex0] ?? "").trim();
  const bottomToday = String(bottomRow[todayColumnIndex0] ?? "").trim();
  return topToday === "$" || bottomToday === "$";
}

function findTodayDollarCodes(values) {
  const today = getKoreaToday();
  const todayColumnIndex0 = findTodayColumnIndex(values, today.day);
  const codes = [];
  const seen = new Set();

  // 오늘상환 알림 대상 조회 조건을 단순화한다.
  // 조건: 상태가 진행중이고, 오늘 날짜 칸에 $가 있으며, F열 상품명에서 코드가 추출되는 고객.
  // B열/H열 날짜 계산이나 시작월 필터는 사용하지 않는다.
  for (let i = LINE_CUSTOMER_START_INDEX0; i < values.length; i += 2) {
    const row = values[i] || [];
    const status = String(row[2] || "").trim(); // C열 상태
    const productName = String(row[5] || "").trim(); // F열 상품명

    if (status !== "진행중") continue;
    if (!hasDollarToday(values, i, todayColumnIndex0)) continue;

    const code = extractCustomerCodeFromProductName(productName);
    if (!code) continue;

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

  // 미등록은 라인 그룹 고객 구간인 1058행부터, 고객 1명당 2행씩 검색
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

async function sendTodayRepaymentBroadcast(broadcastMessage, codePrefix = "") {
  if (!SHEET_ID) {
    return "⚠️ GOOGLE_SHEET_ID 환경변수가 설정되지 않았습니다.";
  }

  const targetPrefix = String(codePrefix || "").trim().toUpperCase();

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

  const rawCodes = findTodayDollarCodes(values);
  const filteredRawCodes = targetPrefix
    ? rawCodes.filter(code => String(code || "").toUpperCase().startsWith(targetPrefix))
    : rawCodes;
  const codes = [];
  const unregisteredCodes = [];
  const seenGroupIds = new Set();
  const seenUnregisteredCodes = new Set();

  for (const code of filteredRawCodes) {
    const groupId = groupMap.get(code);

    if (!groupId) {
      if (!seenUnregisteredCodes.has(code)) {
        seenUnregisteredCodes.add(code);
        unregisteredCodes.push(code);
      }
      continue;
    }

    if (seenGroupIds.has(groupId)) continue;
    seenGroupIds.add(groupId);
    codes.push(code);
  }

  if (!codes.length) {
    const prefixNotice = targetPrefix ? ` (${targetPrefix} 대상)` : "";

    if (unregisteredCodes.length) {
      return `⚠️ 오늘 발송 대상이 없습니다${prefixNotice}.\n\n그룹 미등록: ${unregisteredCodes.length}명\n${unregisteredCodes.join("\n")}`;
    }

    return `⚠️ 오늘 발송 대상이 없습니다${prefixNotice}.`;
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

  const summaryLines = targetPrefix
    ? [`✅ 발송 완료`, ``, `대상코드: ${targetPrefix}`, `발송 완료: ${successCount}건`]
    : [`✅ 발송 완료`, ``, `발송 완료: ${successCount}건`];

  if (unregisteredCodes.length) {
    summaryLines.push(`그룹 미등록: ${unregisteredCodes.length}명`, ``, ...unregisteredCodes);
  } else {
    summaryLines.push(`그룹 미등록: 0명`);
  }

  if (failedItems.length) {
    const lines = failedItems.map(item => `${item.code} - ${item.error}`);
    return `❌ 발송 일부 실패\n\n${summaryLines.join("\n")}\n\n실패: ${failedItems.length}건\n${lines.join("\n")}`;
  }

  return summaryLines.join("\n");
}


function findTodayColumnIndex(values, day) {
  const header = values[0] || [];
  for (let col = DATE_START_COLUMN_INDEX; col <= DATE_END_COLUMN_INDEX; col += 1) {
    const cell = header[col];
    if (Number(cell) === Number(day)) return col;
  }
  return DATE_START_COLUMN_INDEX + day - 1;
}

function getKoreaYesterdayInfo(todayInfo = null) {
  const today = todayInfo || getKoreaToday();
  if (today.day > 1) {
    return { year: today.year, month: today.month, day: today.day - 1 };
  }

  if (today.month > 1) {
    const month = today.month - 1;
    return { year: today.year, month, day: getDaysInMonth(today.year, month) };
  }

  return { year: today.year - 1, month: 12, day: 31 };
}

function buildRepaymentRolloverUpdates(values, todayInfo = null) {
  const today = todayInfo || getKoreaToday();
  const yesterday = getKoreaYesterdayInfo(today);
  const todayColumnIndex0 = findTodayColumnIndex(values, today.day);
  const yesterdayColumnIndex0 = findTodayColumnIndex(values, yesterday.day);
  const updates = [];
  let activeCount = 0;
  let yesterdayXCount = 0;
  let todayDollarCount = 0;

  // 고객 데이터는 1058행부터 고객 1명당 2행 구조다.
  // 진행중 건만 대상으로 하며, 전날 $가 남아 있는 같은 행만 오늘 날짜로 이월한다.
  // 오늘 칸에 숫자가 있거나 이미 $가 있으면 절대 덮어쓰지 않는다.
  for (let i = LINE_CUSTOMER_START_INDEX0; i < values.length; i += 2) {
    const topRow = values[i] || [];
    const bottomRow = values[i + 1] || [];
    const status = String(topRow[2] || "").trim(); // C열 상태
    const productName = String(topRow[5] || "").trim(); // F열 상품명
    const customerName = String(topRow[6] || "").trim(); // G열 고객명

    if (status !== "진행중") continue;
    if (!customerName && !extractCustomerCodeFromProductName(productName)) continue;

    activeCount += 1;

    for (const offset of [0, 1]) {
      const rowIndex0 = i + offset;
      const row = offset === 0 ? topRow : bottomRow;
      const rowNumber = rowIndex0 + 1;
      const yesterdayValue = String(row[yesterdayColumnIndex0] ?? "").trim();
      const todayValue = String(row[todayColumnIndex0] ?? "").trim();

      if (yesterdayValue !== "$") continue;

      updates.push({ rowNumber, columnIndex0: yesterdayColumnIndex0, value: "X" });
      yesterdayXCount += 1;

      if (isBlankCell(todayValue) || todayValue === "-") {
        updates.push({ rowNumber, columnIndex0: todayColumnIndex0, value: "$" });
        todayDollarCount += 1;
      }
    }
  }

  return {
    today,
    yesterday,
    todayColumnIndex0,
    yesterdayColumnIndex0,
    activeCount,
    yesterdayXCount,
    todayDollarCount,
    updates
  };
}


function buildManualDateChangePlan(values, todayInfo = null) {
  const today = todayInfo || getKoreaToday();
  const yesterday = getKoreaYesterdayInfo(today);
  const todayColumnIndex0 = findTodayColumnIndex(values, today.day);
  const yesterdayColumnIndex0 = findTodayColumnIndex(values, yesterday.day);
  const updates = [];
  const backupItems = [];
  const backupSeenRows = new Set();
  let activeCount = 0;
  let yesterdayDollarTotal = 0;
  let yesterdayXCount = 0;
  let todayDollarCount = 0;

  function addBackup(rowNumber, yesterdayValue, todayValue) {
    if (backupSeenRows.has(rowNumber)) return;
    backupSeenRows.add(rowNumber);
    backupItems.push({
      rowNumber,
      yesterdayColumnIndex0,
      todayColumnIndex0,
      yesterdayValue,
      todayValue
    });
  }

  // 날짜변경 명령어 전용 로직.
  // 순서: 오늘 날짜에 $ 먼저 생성 → 어제 날짜의 $를 X로 변경.
  // 진행중 고객만 대상으로 하며, 숫자/X/메모 등 기존 값은 덮어쓰지 않는다.
  // 특정 시작 행(예: 1058행)으로 제한하지 않고 전체 시트에서 C열이 "진행중"인 고객 행을 모두 검사한다.
  for (let i = 1; i < values.length; i += 1) {
    const topRow = values[i] || [];
    const bottomRow = values[i + 1] || [];
    const status = String(topRow[2] || "").trim(); // C열 상태
    const productName = String(topRow[5] || "").trim(); // F열 상품명
    const customerName = String(topRow[6] || "").trim(); // G열 고객명

    if (status !== "진행중") continue;
    if (!customerName && !extractCustomerCodeFromProductName(productName)) continue;

    activeCount += 1;

    for (const offset of [0, 1]) {
      const rowIndex0 = i + offset;
      const row = offset === 0 ? topRow : bottomRow;
      const rowNumber = rowIndex0 + 1;
      const yesterdayValueRaw = row[yesterdayColumnIndex0] ?? "";
      const yesterdayValue = String(yesterdayValueRaw).trim();

      // 날짜변경 대상은 "어제 $"인 진행중 고객만이다.
      // 오늘 칸이 비어있는 진행중 전체에 $를 찍지 않는다.
      if (yesterdayValue !== "$") continue;

      // 월말 -> 다음달 1일 전환에서는 상/하 행을 교차한다.
      // 예: 아래 행 31일 $ -> 위 행 1일 $, 위 행 31일 $ -> 아래 행 1일 $.
      // 평소 날짜변경은 기존처럼 같은 행의 다음 날짜를 사용한다.
      const isMonthRollover = yesterday.month !== today.month;
      const targetRowIndex0 = isMonthRollover
        ? (offset === 0 ? i + 1 : i)
        : rowIndex0;
      const targetRowNumber = targetRowIndex0 + 1;
      const targetRow = values[targetRowIndex0] || [];
      const todayValueRaw = targetRow[todayColumnIndex0] ?? "";
      const todayValue = String(todayValueRaw).trim();

      yesterdayDollarTotal += 1;

      // 날짜복구가 월말 교차 이동도 정확히 되돌릴 수 있도록
      // 출발 행과 도착 행을 각각 백업한다.
      addBackup(rowNumber, yesterdayValueRaw, row[todayColumnIndex0] ?? "");
      if (targetRowNumber !== rowNumber) {
        addBackup(
          targetRowNumber,
          targetRow[yesterdayColumnIndex0] ?? "",
          todayValueRaw
        );
      }

      // 실행 순서: 오늘 $ 생성 → 어제 $를 X로 변경.
      // 단, 오늘 칸에 이미 값이 있으면 덮어쓰지 않는다.
      if (isBlankCell(todayValue) || todayValue === "-") {
        updates.push({ rowNumber: targetRowNumber, columnIndex0: todayColumnIndex0, value: "$" });
        todayDollarCount += 1;
      }

      updates.push({ rowNumber, columnIndex0: yesterdayColumnIndex0, value: "X" });
      yesterdayXCount += 1;
    }
  }

  return {
    today,
    yesterday,
    todayColumnIndex0,
    yesterdayColumnIndex0,
    activeCount,
    yesterdayDollarTotal,
    yesterdayXCount,
    todayDollarCount,
    updates,
    backupItems
  };
}

async function runManualDateChange() {
  if (!SHEET_ID) {
    return "⚠️ GOOGLE_SHEET_ID 환경변수가 설정되지 않았습니다.";
  }

  const accessToken = await getGoogleAccessToken();
  const values = await getSheetValues(accessToken);
  const result = buildManualDateChangePlan(values);
  const runId = `datechange-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  const backupTime = getKoreaDateTimeText();

  if (!result.updates.length) {
    return [
      "⚠️ 날짜 변경 대상이 없습니다.",
      "",
      `오늘($) 생성 : ${result.todayDollarCount}건`,
      `어제($→X) 변경 : ${result.yesterdayXCount}건`,
      "",
      "※ 기존 날짜복구 백업은 유지했습니다."
    ].join("\n");
  }

  await clearDateChangeBackupSheet(accessToken);
  await appendDateChangeBackupRows(accessToken, result.backupItems.map(item => [
    runId,
    item.rowNumber,
    columnNumberToLetter(item.yesterdayColumnIndex0 + 1),
    columnNumberToLetter(item.todayColumnIndex0 + 1),
    item.yesterdayValue ?? "",
    item.todayValue ?? "",
    backupTime,
    "ready"
  ]));

  await batchUpdateSheetCells(accessToken, result.updates);

  return [
    "✅ 날짜 변경 완료",
    "",
    `오늘($) 생성 : ${result.todayDollarCount}건`,
    `어제($→X) 변경 : ${result.yesterdayXCount}건`,
    "",
    "※ 필요 시 '날짜복구' 명령으로 이전 상태를 복원할 수 있습니다."
  ].join("\n");
}

async function restoreLastManualDateChange() {
  if (!SHEET_ID) {
    return "⚠️ GOOGLE_SHEET_ID 환경변수가 설정되지 않았습니다.";
  }

  const accessToken = await getGoogleAccessToken();
  const rows = await getDateChangeBackupValues(accessToken);
  const dataRows = rows.slice(1).filter(row => String(row?.[0] || "").trim());

  if (!dataRows.length) {
    return "⚠️ 복구할 날짜변경 백업이 없습니다.";
  }

  const latestRunId = String(dataRows[dataRows.length - 1]?.[0] || "").trim();
  const restoreRows = dataRows.filter(row => String(row?.[0] || "").trim() === latestRunId);
  const updates = [];
  const restoredRowNumbers = new Set();

  // 날짜복구는 특정 시작 행(예: 1058행) 기준으로 다시 검색하지 않는다.
  // 날짜변경 때 백업된 전체 행번호를 그대로 사용해 복구한다.
  for (const row of restoreRows) {
    const rowNumber = Number(row[1]);
    const yesterdayColumnIndex0 = columnLetterToIndex0(row[2]);
    const todayColumnIndex0 = columnLetterToIndex0(row[3]);
    if (!Number.isFinite(rowNumber) || !Number.isFinite(yesterdayColumnIndex0) || !Number.isFinite(todayColumnIndex0)) continue;

    restoredRowNumbers.add(rowNumber);
    updates.push({ rowNumber, columnIndex0: yesterdayColumnIndex0, value: row[4] ?? "" });
    updates.push({ rowNumber, columnIndex0: todayColumnIndex0, value: row[5] ?? "" });
  }

  if (!updates.length) {
    return "⚠️ 날짜변경 백업을 읽었지만 복구할 셀을 찾지 못했습니다.";
  }

  await batchUpdateSheetCells(accessToken, updates);
  await clearDateChangeBackupSheet(accessToken);

  return [
    "✅ 날짜 복구 완료",
    "",
    `복구 행 : ${restoredRowNumbers.size}건`,
    `복구 셀 : ${updates.length}건`
  ].join("\n");
}

export async function runRepaymentRolloverCron() {
  if (!SHEET_ID) {
    return "⚠️ GOOGLE_SHEET_ID 환경변수가 설정되지 않았습니다.";
  }

  const accessToken = await getGoogleAccessToken();
  const values = await getSheetValues(accessToken);
  const result = buildRepaymentRolloverUpdates(values);

  if (result.updates.length) {
    await batchUpdateSheetCells(accessToken, result.updates);
  }

  const todayText = `${result.today.year}-${pad2(result.today.month)}-${pad2(result.today.day)}`;
  const yesterdayText = `${result.yesterday.year}-${pad2(result.yesterday.month)}-${pad2(result.yesterday.day)}`;

  return {
    message: "repayment rollover completed",
    yesterday: yesterdayText,
    today: todayText,
    activeCount: result.activeCount,
    yesterdayDollarToX: result.yesterdayXCount,
    todayBlankOrDashToDollar: result.todayDollarCount,
    updatedCells: result.updates.length
  };
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
  const nextSlot = findNextCustomerSlot(values);
  const nextNo = nextSlot.customerNo;
  const rowNumber = nextSlot.rowNumber;

  // 마지막 방어선: 선택된 2행에 고객번호/양식 수식 외의 값이 있으면 쓰기를 중단한다.
  // 슬롯 탐색 기준이 나중에 바뀌더라도 기존 적용칸을 덮어쓰지 않게 한다.
  if (!isEmptyCustomerSlot(values, rowNumber - 1)) {
    return `⚠️ ${rowNumber}행에 기존 적용값이 있어 등록을 중단했습니다. 다음 빈칸을 확인해주세요.`;
  }

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

  const targetStatus = command.status === "블랙" ? "블랙" : "종료";
  await updateSheetCell(accessToken, topRowNumber, 2, targetStatus);
  await applyClosedCustomerStyle(accessToken, topRowNumber);

  const completionText = `✅ ${command.code} ${targetStatus} 처리완료\n${managerProfitText}`;
  if (targetStatus !== "종료" || managerProfit === null) {
    return completionText;
  }

  const finalAmountWon = Math.round(managerProfit * 10000).toLocaleString("ko-KR");
  return [
    { type: "text", text: completionText },
    { type: "text", text: `${command.code} - ${finalAmountWon}` }
  ];
}

const ignoreKeywords = [
  "110551366954",
  "Important checking",
  "Check over",
    "commission",
  "Commission"
];

const COMMISSION_ACCOUNT_LABEL_PATTERN = /^(?:관리자\s*)?(?:계좌\s*정보|bank\s*information|payment\s*information|name|family\s*name|bank|phone(?:\s*(?:no\.?|number))?|account(?:\s*(?:no\.?|number|name))?|beneficiary|swift|iban|ชื่อ(?:บัญชี)?|นามสกุล|ธนาคาร|เบอร์(?:โทร)?|เลข(?:ที่)?บัญชี|예금주|은행|계좌(?:번호)?|전화(?:번호)?|휴대폰)(?=\s|[:：-]|$)/iu;
const COMMISSION_BONUS_LABEL_PATTERN = /(?:보너스|bonus|โบนัส)/iu;
const COMMISSION_CODE_PATTERN = /^[\s*•·▪▫▶▷►→👉📌📍-]*([a-z]{1,10}\s*[-_]?\s*\d{1,6})\s*(?:[-–—:：/|]|\s)\s*(.+?)\s*$/i;
const COMMISSION_NAMED_ITEM_PATTERN = /^[\s*•·▪▫▶▷►→👉📌📍-]*(.+?\S)\s*[-–—]\s*(.+?)\s*$/u;
const COMMISSION_AMOUNT_PATTERN = /^(?:₩\s*)?([+-]?\d{1,3}(?:[,.\s]\d{3})*|[+-]?\d+)(?:\.00)?\s*(?:원|won|วอน|บาท|baht|thb)?$/iu;

function isCommissionSeparatorLine(line) {
  return !line || /^[\s\-=—–_.*•·📍📌]+$/u.test(line);
}

function parseCommissionAmount(value) {
  const match = String(value || "").trim().match(COMMISSION_AMOUNT_PATTERN);
  if (!match) return null;

  const normalized = match[1].replace(/[,.\s]/g, "");
  if (!/^[+-]?\d+$/.test(normalized)) return null;

  const amount = Number(normalized);
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : null;
}

function extractCommissionItem(line) {
  const clean = String(line || "").trim();
  if (!clean || clean.includes("=") || /[+×*]/.test(clean)) return null;

  if (COMMISSION_BONUS_LABEL_PATTERN.test(clean)) {
    const amountText = clean
      .replace(/^\s*[\s*•·▪▫▶▷►→👉📌📍-]*/u, "")
      .replace(/^.*?(?:보너스|bonus|โบนัส)\s*(?:[-–—:：/|]|\s)\s*/iu, "");
    const amount = parseCommissionAmount(amountText);
    return amount === null ? null : { type: "bonus", amount };
  }

  const codeMatch = clean.match(COMMISSION_CODE_PATTERN);
  if (codeMatch) {
    const amount = parseCommissionAmount(codeMatch[2]);
    if (amount !== null) {
      return { type: "code", code: codeMatch[1].replace(/\s+/g, "").toUpperCase(), amount };
    }
  }

  // 코드뿐 아니라 "주간이벤트 - 50,000", "월간이벤트 - 100,000"처럼
  // 임의의 항목명 뒤에 하이픈과 금액이 적힌 줄도 커미션 합산에 포함한다.
  const namedItemMatch = clean.match(COMMISSION_NAMED_ITEM_PATTERN);
  if (!namedItemMatch) return null;

  const amount = parseCommissionAmount(namedItemMatch[2]);
  return amount === null ? null : { type: "named", label: namedItemMatch[1].trim(), amount };
}

function cleanCommissionManagerName(line) {
  return String(line || "")
    .trim()
    .replace(/^[\s*•·▪▫▶▷►→👉📌📍💸💰👑✅]+/u, "")
    .replace(/^(?:관리자|manager|admin)\s*[:：-]?\s*/i, "")
    .trim();
}

function parseCommissionSummary(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n").map(line => line.trim());
  const commissionIndex = lines.findIndex(line => /\bcommission\b/i.test(line));
  let accountStartIndex = lines.findIndex((line, index) =>
    index > Math.max(commissionIndex, 0) && COMMISSION_ACCOUNT_LABEL_PATTERN.test(line)
  );

  const items = [];
  const itemStartIndex = commissionIndex >= 0 ? commissionIndex + 1 : 0;
  const itemEndIndex = accountStartIndex >= 0 ? accountStartIndex : lines.length;
  let firstItemIndex = -1;
  let lastItemIndex = -1;
  for (let i = itemStartIndex; i < itemEndIndex; i += 1) {
    const line = lines[i];
    const item = extractCommissionItem(line);
    if (item) {
      if (firstItemIndex < 0) firstItemIndex = i;
      lastItemIndex = i;
      items.push(item);
    }
  }

  // Commission 제목 또는 하단 계좌정보로 정산 양식임을 확인하므로
  // 코드 없이 보너스 한 건만 있는 관리자도 자동 계산한다.
  if (items.length < 1) return null;

  // 라벨 없는 계좌정보도 지원한다.
  // 마지막 정산 항목 뒤에 구분선이 나오면 그 아래의 모든 내용줄을 계좌정보로 본다.
  if (accountStartIndex < 0 && lastItemIndex >= 0) {
    const separatorIndex = lines.findIndex((line, index) =>
      index > lastItemIndex && isCommissionSeparatorLine(line) && Boolean(line)
    );
    if (separatorIndex >= 0) {
      const firstTrailingContentIndex = lines.findIndex((line, index) =>
        index > separatorIndex && Boolean(line) && !isCommissionSeparatorLine(line)
      );
      if (firstTrailingContentIndex >= 0) accountStartIndex = firstTrailingContentIndex;
    }
  }

  // Commission 제목이 없는 양식은 라벨 유무와 관계없이 하단 계좌정보 블록이
  // 확인되어야 정산 공지로 인식한다. 단, 계좌정보도 없는 간단 정산 양식은
  // 첫 내용줄 하나만 관리자명이고 이후 모든 내용줄이 정산 항목일 때만 허용한다.
  // 이렇게 하면 일반 채팅 속 코드/숫자를 정산으로 오인하지 않으면서 아래 형식도 계산할 수 있다.
  // 오이
  // O06 - 120,000
  // OI05 - 132,900
  const bareSummaryContentIndexes = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => Boolean(line) && !isCommissionSeparatorLine(line));
  const isBareItemsOnlySummary = commissionIndex < 0
    && accountStartIndex < 0
    && firstItemIndex > 0
    && bareSummaryContentIndexes.length === items.length + 1
    && bareSummaryContentIndexes[0].index < firstItemIndex
    && bareSummaryContentIndexes.slice(1).every(({ line }) => Boolean(extractCommissionItem(line)));

  if (commissionIndex < 0 && accountStartIndex < 0 && !isBareItemsOnlySummary) return null;

  let managerName = "";
  if (commissionIndex >= 0) {
    for (let i = commissionIndex - 1; i >= 0; i -= 1) {
      if (isCommissionSeparatorLine(lines[i])) continue;
      managerName = cleanCommissionManagerName(lines[i]);
      if (managerName) break;
    }
  } else {
    // 제목이 없는 양식에서는 사용자가 정한 규칙대로 맨 위의 첫 내용줄을 관리자명으로 사용한다.
    for (let i = 0; i < firstItemIndex; i += 1) {
      if (isCommissionSeparatorLine(lines[i])) continue;
      managerName = cleanCommissionManagerName(lines[i]);
      if (managerName) break;
    }
  }
  if (!managerName) return null;

  const total = items.reduce((sum, item) => sum + item.amount, 0);
  if (!Number.isSafeInteger(total)) return null;

  const accountLines = accountStartIndex < 0
    ? []
    : lines.slice(accountStartIndex).filter(line => line && !isCommissionSeparatorLine(line));

  return { managerName, total, items, accountLines };
}

function buildCommissionSummaryReply(summary) {
  const lines = [summary.managerName, `총 합계금액 : ${summary.total.toLocaleString("en-US")}`];
  if (summary.accountLines?.length) {
    lines.push("---------------------------", ...summary.accountLines);
  }
  return lines.join("\n");
}

export { parseCommissionSummary, buildCommissionSummaryReply };

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
  "잠깐": "เดี๋ยวก่อนครับ",
  "수고하셨습니다": "ขอบคุณที่ทำงานหนักครับ",
  "수고하셨어요": "ขอบคุณที่ทำงานหนักครับ",
  "수고했어요": "ขอบคุณที่ทำงานหนักครับ",
  "수고 많으셨습니다": "ขอบคุณที่ทำงานหนักมากครับ",
  "수고 많으셨어요": "ขอบคุณที่ทำงานหนักมากครับ"
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

// 한글 명령어를 영문 두벌식 자판 상태로 입력한 경우에도 같은 명령으로 처리한다.
// 일반 대화나 고객명은 바꾸지 않고, 아래에 등록된 명령어 형태만 정확히 복원한다.
function koreanToEnglishKeyboard(text) {
  const initials = ["r", "R", "s", "e", "E", "f", "a", "q", "Q", "t", "T", "d", "w", "W", "c", "z", "x", "v", "g"];
  const medials = ["k", "o", "i", "O", "j", "p", "u", "P", "h", "hk", "ho", "hl", "y", "n", "nj", "np", "nl", "b", "m", "ml", "l"];
  const finals = ["", "r", "R", "rt", "s", "sw", "sg", "e", "f", "fr", "fa", "fq", "ft", "fx", "fv", "fg", "a", "q", "qt", "t", "T", "d", "w", "c", "z", "x", "v", "g"];

  return Array.from(String(text || "")).map(char => {
    const code = char.charCodeAt(0) - 0xAC00;
    if (code < 0 || code > 11171) return char;
    const initial = Math.floor(code / 588);
    const medial = Math.floor((code % 588) / 28);
    const final = code % 28;
    return initials[initial] + medials[medial] + finals[final];
  }).join("");
}

const KOREAN_COMMAND_WORDS = [
  "등록", "종료", "종결", "블랙", "조회", "카운트",
  "날짜변경", "날짜복구", "미등록", "내아이디", "관리자아이디확인",
  "송금완료", "오늘상환요청", "오늘상환요청테스트", "오늘상환오전", "오늘상환오후"
];
const ENGLISH_KEYBOARD_COMMAND_ALIASES = new Map(
  KOREAN_COMMAND_WORDS.map(word => [koreanToEnglishKeyboard(word), word])
);

function normalizeDubeolsikKeyCase(text) {
  // 두벌식에서 Shift가 별도 자모를 만드는 R/E/Q/T/W/O/P는 보존한다.
  // 나머지 키는 사용자가 Shift/Caps Lock을 섞어 눌러도 같은 명령으로 본다.
  return String(text || "").replace(/[ASDFGHJKLZXCVBNM]/g, char => char.toLowerCase());
}

function normalizeEnglishKeyboardCommand(text) {
  const clean = normalizeText(text);
  if (!clean) return clean;

  // 단독 명령어. /미등록은 기존의 별도 기능 구분을 그대로 유지한다.
  const hasLeadingSlash = clean.startsWith("/");
  const standalone = hasLeadingSlash ? clean.slice(1) : clean;
  const standaloneWord = ENGLISH_KEYBOARD_COMMAND_ALIASES.get(normalizeDubeolsikKeyCase(standalone))
    || (KOREAN_COMMAND_WORDS.includes(standalone) ? standalone : null);
  if (standaloneWord) {
    if (standaloneWord === "미등록") return hasLeadingSlash ? "/미등록" : "미등록";
    return standaloneWord;
  }

  // 코드/종료, 이름/조회, 코드/카운트3 같은 접미 명령어.
  for (const word of ["등록", "종료", "종결", "블랙", "조회"]) {
    const alias = koreanToEnglishKeyboard(word);
    const tail = clean.slice(-alias.length);
    if (clean.charAt(clean.length - alias.length - 1) === "/" && normalizeDubeolsikKeyCase(tail) === alias) {
      return `${clean.slice(0, -alias.length)}${word}`;
    }
  }

  const countAlias = koreanToEnglishKeyboard("카운트");
  const countMatch = clean.match(/\/([^/]+?)(\d+)$/);
  if (countMatch && normalizeDubeolsikKeyCase(countMatch[1]) === countAlias) {
    return `${clean.slice(0, -countMatch[0].length)}/카운트${countMatch[2]}`;
  }

  // 오늘상환... 명령어 뒤의 선택 코드(/KN 등)는 그대로 둔다.
  for (const word of ["오늘상환요청", "오늘상환오전", "오늘상환오후"]) {
    const alias = koreanToEnglishKeyboard(word);
    const head = clean.slice(0, alias.length);
    if (normalizeDubeolsikKeyCase(head) === alias && (clean.length === alias.length || clean.charAt(alias.length) === "/")) {
      return word + clean.slice(alias.length);
    }
  }

  return clean;
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

  // Korean -> Thai 결과에는 한글이 한 글자라도 남으면 안 된다.
  // 예: "수고 많으셨습니다ครับ"처럼 태국어 종결어만 붙은 혼합 결과도 실패 처리한다.
  if (containsKorean(translatedText)) return true;
  if (!containsThai(translatedText)) return true;

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
  return (
    clean.includes("1,000,000") ||
    compactNumberText.includes("1000000") ||
    clean.includes("2,000,000") ||
    compactNumberText.includes("2000000")
  );
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

Tone inference rules:
- Infer the tone primarily from the current message itself: vocabulary, sentence endings, command forms, honorifics, emotional expressions, punctuation, and degree of directness.
- Use recent conversation only as secondary evidence for familiarity, hierarchy, tension, and the speaker's usual style.
- Do not require explicit identification of whether the speaker or listener is an owner, manager, or customer.
- Translate a soft message softly and a strong message strongly.
- Preserve the original level of politeness, friendliness, authority, irritation, pressure, coldness, sarcasm, anger, and intimidation as closely as natural Thai allows.
- Do not automatically soften commands, warnings, demands, or pressure into gentle requests merely to sound polite or natural.
- Polite wording and ครับ may coexist with a firm command. Judge the whole sentence and preserve both its politeness and its force.
- Do not intensify the message beyond the original or invent threats, insults, or hostile intent.
- When the relationship is uncertain, stay close to the tone and force of the current sentence instead of guessing a role.

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
- When the entire input consists only of laughter such as ㅋㅋ, ㅎㅎ, lol, lmao, or 555, output laughter only.
- Never add ครับ, ค่ะ, นะ, จ้า, or any other ending particle to a laughter-only message.
- Examples: ㅋㅋ -> 555 / ㅋㅋㅋㅋ -> 55555 / ㅎㅎㅎㅎ -> 55555 / lol -> 555
- When laughter appears together with a real sentence, translate the sentence naturally and render the laughter as 555 when appropriate.
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

Tone inference rules:
- Infer the tone primarily from the current message itself: vocabulary, sentence endings, command forms, honorifics, emotional expressions, punctuation, and degree of directness.
- Use recent conversation only as secondary evidence for familiarity, hierarchy, tension, and the speaker's usual style.
- Do not require explicit identification of whether the speaker or listener is an owner, manager, or customer.
- Translate a soft message softly and a strong message strongly.
- Preserve the original level of politeness, friendliness, authority, irritation, pressure, coldness, sarcasm, anger, and intimidation as closely as natural Korean allows.
- Do not automatically soften commands, warnings, demands, or pressure into gentle requests merely to sound polite or natural.
- Thai particles such as ครับ and ค่ะ may coexist with a firm command. Judge the whole sentence rather than treating these particles as proof of a gentle tone.
- Preserve both layers when a sentence is grammatically polite but functionally direct, commanding, pressuring, or intimidating.
- Do not intensify the message beyond the original or invent threats, insults, or hostile intent.
- When the relationship is uncertain, stay close to the tone and force of the current sentence instead of guessing a role.

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

function getLaughterOnlyTranslation(text) {
  const clean = String(text || "").trim();
  const compact = clean.replace(/\s+/g, "");

  // 웃음만 있는 메시지는 모델에 보내지 않고 직접 처리한다.
  // 종결어(ครับ/ค่ะ/นะ/จ้า 등)를 절대 덧붙이지 않는다.
  const koreanLaugh = compact.match(/^([ㅋㅎ]{2,})([!?~～…]*)$/u);
  if (koreanLaugh) {
    const laughCount = koreanLaugh[1].length;
    const suffix = koreanLaugh[2] || "";
    return `${"5".repeat(Math.max(3, laughCount + 1))}${suffix}`;
  }

  const englishLaugh = compact.match(/^(lol+|lmao+|rofl+)([!?~～…]*)$/iu);
  if (englishLaugh) {
    return `555${englishLaugh[2] || ""}`;
  }

  const thaiLaugh = compact.match(/^(5{3,})([!?~～…]*)$/u);
  if (thaiLaugh) {
    return `${thaiLaugh[1]}${thaiLaugh[2] || ""}`;
  }

  return null;
}

async function translateKoToTh(text, history = []) {
  const clean = normalizeText(text);
  const laughterOnly = getLaughterOnlyTranslation(clean);
  if (laughterOnly) return laughterOnly;

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

  // 재시도 결과도 검증한다. 두 번째 결과까지 잘못된 경우 한국어가 섞인 문장을
  // 고객에게 보내지 않고, 안전한 태국어 안내문만 반환한다.
  if (isBadKoToThOutput(clean, translated)) {
    console.error("Korean-to-Thai translation validation failed after retry");
    return "ขออภัย ไม่สามารถแปลข้อความนี้ได้ กรุณาลองส่งอีกครั้งครับ";
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


function getKoreaHourNumber(date = new Date()) {
  const hourText = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    hour12: false
  }).format(date);
  const hour = Number(hourText);
  return Number.isFinite(hour) ? hour : null;
}

function isPendingRegistrationReminderHour(date = new Date()) {
  const hour = getKoreaHourNumber(date);
  if (!Number.isFinite(hour)) return false;
  return hour >= 9 && hour <= 23;
}

async function getReceiptPendingItems(accessToken, statuses = ["pending"]) {
  await ensureReceiptPendingSheet(accessToken);
  const range = `'${escapeSheetName(RECEIPT_PENDING_SHEET_NAME)}'!A:O`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}`;
  const response = await axios.get(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const values = response.data.values || [];
  return values
    .slice(1)
    .map((row, idx) => receiptPendingFromRow(row, idx + 2))
    .filter(item => statuses.includes(String(item.status || "").toLowerCase()));
}

async function getCheckOverPendingItems(accessToken, statuses = ["pending"]) {
  await ensureCheckOverPendingSheet(accessToken);
  const range = `'${escapeSheetName(CHECKOVER_PENDING_SHEET_NAME)}'!A:L`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}`;
  const response = await axios.get(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const values = response.data.values || [];
  return values
    .slice(1)
    .map((row, idx) => checkOverPendingFromRow(row, idx + 2))
    .filter(item => statuses.includes(String(item.status || "").toLowerCase()));
}

function uniquePendingCodes(items) {
  const seen = new Set();
  const codes = [];
  for (const item of items || []) {
    const code = String(item?.code || "").trim().toUpperCase();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    codes.push(code);
  }
  return codes;
}

function buildPendingRegistrationReminderText(receiptItems = [], checkOverItems = []) {
  const receiptCodes = uniquePendingCodes(receiptItems);
  const checkOverCodes = uniquePendingCodes(checkOverItems);
  const total = receiptCodes.length + checkOverCodes.length;
  if (total < 1) return "";

  const lines = ["⚠️ 등록 미처리 알림", ""];
  if (receiptCodes.length) {
    lines.push("[입금사진]", ...receiptCodes.map(code => `• ${code}`), "");
  }
  if (checkOverCodes.length) {
    lines.push("[Check Over]", ...checkOverCodes.map(code => `• ${code}`), "");
  }
  lines.push(`총 ${total}건이 아직 등록되지 않았습니다.`);
  return lines.join("\n").trim();
}


function buildProcessingReviewText(receiptItems = [], checkOverItems = []) {
  const lines = [];
  for (const item of receiptItems) lines.push(`• 입금사진 ${item.code || "-"}${item.updatedAt ? ` / ${item.updatedAt}` : ""}`);
  for (const item of checkOverItems) lines.push(`• Check Over ${item.code || "-"}${item.customerName ? ` / ${item.customerName}` : ""}`);
  if (!lines.length) return "";
  return ["⚠️ 처리 상태 확인 필요", "아래 항목은 processing 상태라 재등록 버튼을 생성하지 않았습니다.", "통합 시트 반영 여부를 확인해주세요.", "", ...lines].join("\n");
}

function chunkLineMessages(messages, size = 5) {
  const chunks = [];
  for (let i = 0; i < messages.length; i += size) chunks.push(messages.slice(i, i + size));
  return chunks;
}

function buildPendingRegistrationButtonMessages(receiptItems = [], checkOverItems = []) {
  const messages = [];

  for (const item of receiptItems) {
    if (!item.pendingId || !item.code || !item.amountWon || !item.sheetValue) continue;
    messages.push(...buildReceiptConfirmMessages({
      code: item.code,
      amountWon: item.amountWon,
      sheetValue: item.sheetValue,
      senderName: item.senderName,
      accountNumber: item.accountNumber,
      transferDate: item.transferDate,
      receiptKey: item.infoKey || item.imageKey || item.nearDuplicateKey,
      sourceGroupId: item.sourceGroupId,
      pendingId: item.pendingId,
      approvalNotice: true
    }));
  }

  for (const item of checkOverItems) {
    if (!item.pendingId || !item.code || !Number.isFinite(item.productAmount) || !Number.isFinite(item.loanAmount) || !Number.isFinite(item.cut)) continue;
    const command = {
      adminName: item.adminName || "관리자",
      productCode: item.code,
      productName: `${item.code}(${Number(item.productAmount).toLocaleString("ko-KR")})`,
      productAmount: item.productAmount,
      customerName: item.customerName,
      loanAmount: item.loanAmount,
      cut: item.cut,
      checkoverPendingId: item.pendingId
    };
    messages.push(...buildCheckOverConfirmMessages(command, {
      approvalNotice: true,
      sourceGroupId: item.sourceGroupId,
      pendingId: item.pendingId
    }));
  }

  return messages;
}

async function resendPendingRegistrationButtons(event) {
  if (!SHEET_ID) {
    await replyToLine(event.replyToken, "⚠️ GOOGLE_SHEET_ID 환경변수가 설정되지 않았습니다.");
    return;
  }

  const accessToken = await getGoogleAccessToken();
  const approvalGroupId = await getReceiptApprovalGroupId(accessToken);
  const sourceGroupId = getLineSourceGroupId(event);
  if (!approvalGroupId || !sourceGroupId || sourceGroupId !== approvalGroupId) {
    await replyToLine(event.replyToken, `⚠️ /미등록은 ${RECEIPT_APPROVAL_GROUP_CODE} 그룹에서만 사용할 수 있습니다.`);
    return;
  }

  const [receiptItems, checkOverItems, processingReceipts, processingCheckOvers] = await Promise.all([
    getReceiptPendingItems(accessToken, ["pending"]),
    getCheckOverPendingItems(accessToken, ["pending"]),
    getReceiptPendingItems(accessToken, ["processing"]),
    getCheckOverPendingItems(accessToken, ["processing"])
  ]);

  const buttonMessages = buildPendingRegistrationButtonMessages(receiptItems, checkOverItems);
  const pendingCount = receiptItems.length + checkOverItems.length;
  const processingText = buildProcessingReviewText(processingReceipts, processingCheckOvers);
  const outgoing = [];

  if (pendingCount > 0) {
    outgoing.push(buildTextMessage(`📋 미등록 ${pendingCount}건의 등록/취소 버튼을 다시 생성했습니다.
순수 pending 상태인 항목만 표시됩니다.`));
    outgoing.push(...buttonMessages);
  }
  if (processingText) outgoing.push(buildTextMessage(processingText));

  if (!outgoing.length) {
    await replyToLine(event.replyToken, "✅ 등록하지 않은 항목이 없습니다.");
    return;
  }

  const chunks = chunkLineMessages(outgoing, 5);
  await replyToLineMessages(event.replyToken, chunks[0]);
  for (const chunk of chunks.slice(1)) await pushToLineMessages(approvalGroupId, chunk);
}

export async function checkPendingRegistrations(event) {
  if (!SHEET_ID) {
    return "⚠️ GOOGLE_SHEET_ID 환경변수가 설정되지 않았습니다.";
  }

  const accessToken = await getGoogleAccessToken();
  const approvalGroupId = await getReceiptApprovalGroupId(accessToken);
  const sourceGroupId = getLineSourceGroupId(event);

  // 명령어는 등록 확인방(PP01)에서만 실행한다.
  if (!approvalGroupId || !sourceGroupId || sourceGroupId !== approvalGroupId) {
    return `⚠️ /미등록은 ${RECEIPT_APPROVAL_GROUP_CODE} 그룹에서만 사용할 수 있습니다.`;
  }

  const [receiptItems, checkOverItems] = await Promise.all([
    getReceiptPendingItems(accessToken),
    getCheckOverPendingItems(accessToken)
  ]);

  return buildPendingRegistrationReminderText(receiptItems, checkOverItems)
    || "✅ 등록하지 않은 항목이 없습니다.";
}

async function sendPendingRegistrationReminder() {
  if (!isPendingRegistrationReminderHour()) {
    return { ok: true, skipped: true, reason: "outside_allowed_hours" };
  }

  if (!SHEET_ID) {
    return { ok: false, error: "GOOGLE_SHEET_ID is missing" };
  }

  const accessToken = await getGoogleAccessToken();
  const approvalGroupId = await getReceiptApprovalGroupId(accessToken);
  if (!approvalGroupId) {
    return { ok: false, error: `${RECEIPT_APPROVAL_GROUP_CODE} approval group is not mapped` };
  }

  const [receiptItems, checkOverItems] = await Promise.all([
    getReceiptPendingItems(accessToken),
    getCheckOverPendingItems(accessToken)
  ]);

  const text = buildPendingRegistrationReminderText(receiptItems, checkOverItems);
  if (!text) {
    return { ok: true, skipped: true, reason: "no_pending_items", receiptCount: 0, checkOverCount: 0 };
  }

  await pushToLine(
    approvalGroupId,
    text,
    `pending-reminder-${getKoreaDateTimeText().slice(0, 10)}-${getKoreaHourNumber()}`
  );

  return {
    ok: true,
    sent: true,
    targetCode: RECEIPT_APPROVAL_GROUP_CODE,
    receiptCount: uniquePendingCodes(receiptItems).length,
    checkOverCount: uniquePendingCodes(checkOverItems).length
  };
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
        const datechange = parseDateChangePostback(event);
        if (datechange) {
          await handleDateChangePostback(event, datechange);
          continue;
        }

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
        // 고객이 사진을 올린 바로 그 시점의 그룹방 코드부터 확정한다.
        // 이미지 분석이 실패하더라도 이 코드를 실패 알림에 표시한다.
        let imageSourceContext = null;
        if (SHEET_ID) {
          try {
            const sourceGroupId = getLineSourceGroupId(event);
            const accessToken = await getGoogleAccessToken();
            const code = await findMappedCodeByGroupId(accessToken, sourceGroupId);
            imageSourceContext = { accessToken, code: code || "" };
          } catch (err) {
            console.error(`[IMAGE SOURCE CODE LOOKUP FAIL] messageId=${event.message?.id || "-"} error=${err?.response?.data?.error?.message || err?.message || err}`);
          }
        }

        // 한 번의 이미지 호출로 여권/입금사진/기타를 자동 분류하고 필요한 값까지 추출한다.
        const imageResult = await analyzeReceiptImageAmount(event.message.id);
        if (imageResult.ok && imageResult.kind === "passport") {
          await queuePassportNameReply(event, imageResult);
        } else {
          await handleReceiptImageMessage(event, imageResult, imageSourceContext);
        }
        continue;
      }

      if (event.message.type !== "text") continue;

      const text = normalizeText(event.message.text);
      if (!text) continue;
      const commandText = normalizeEnglishKeyboardCommand(text);

      // BAD·블랙리스트·조회 가능이 언급된 그룹 메시지만 장기 기록한다.
      // 기록 실패가 기존 번역/명령 기능을 막지 않도록 오류는 로그만 남긴다.
      if (extractChatRiskKeywords(text).length) {
        try {
          await recordChatRiskMessage(event, text);
        } catch (err) {
          console.error(`[CHAT RISK RECORD FAIL] messageId=${event.message?.id || "-"} error=${err?.response?.data?.error?.message || err?.message || err}`);
        }
      }

      const commissionSummary = parseCommissionSummary(text);
      if (commissionSummary) {
        // 일반 텍스트로 보내야 LINE PC에서는 우클릭 복사,
        // 모바일에서는 길게 눌러 복사를 모두 사용할 수 있다.
        await replyToLine(event.replyToken, buildCommissionSummaryReply(commissionSummary));
        continue;
      }

      if (isTransferCompleteCommand(commandText)) {
        // 송금완료 카드는 관리자만 실행 가능.
        // 고객이 같은 문구를 입력해도 카드가 뜨지 않도록 Check Over 관리자 권한을 재사용한다.
        if (!canManageCheckOver(event)) {
          await replyUnauthorized(event);
          continue;
        }

        await replyToLineMessages(event.replyToken, [buildTransferCompleteFlexMessage()]);
        await pushToLine(getConversationKey(event), TRANSFER_COMPLETE_CREDIT_MESSAGE);
        continue;
      }

      if (parseMyIdCommand(commandText)) {
        const userId = getLineUserId(event);
        await replyToLine(event.replyToken, userId ? `내아이디\n${userId}` : "⚠️ userId를 확인할 수 없습니다.");
        continue;
      }

      const registerGroupCommand = parseRegisterGroupCommand(commandText);
      if (registerGroupCommand) {
        if (!isAdmin(event)) {
          await replyUnauthorized(event);
          continue;
        }

        const registerReply = await registerGroupCode(registerGroupCommand, event);
        await replyToLine(event.replyToken, registerReply);
        continue;
      }

      const dateChangeCommand = parseDateChangeCommand(commandText);
      if (dateChangeCommand) {
        if (!isAdmin(event)) {
          await replyUnauthorized(event);
          continue;
        }

        await replyToLineMessages(event.replyToken, [buildDateChangeConfirmMessage(dateChangeCommand.action)]);
        continue;
      }

      if (parsePendingRegistrationCheckCommand(commandText)) {
        if (!isAdmin(event)) {
          await replyUnauthorized(event);
          continue;
        }

        await resendPendingRegistrationButtons(event);
        continue;
      }

      if (parseUnregisteredCheckCommand(commandText)) {
        if (!isAdmin(event)) {
          await replyUnauthorized(event);
          continue;
        }

        const unregisteredReply = await checkUnregisteredGroups();
        await replyToLine(event.replyToken, unregisteredReply);
        continue;
      }

      if (parseTodayRepaymentTestCommand(commandText)) {
        if (!isAdmin(event)) {
          await replyUnauthorized(event);
          continue;
        }

        const testGroupId = event?.source?.groupId || "";
        if (!testGroupId) {
          await replyToLine(event.replyToken, "⚠️ 오늘상환요청테스트 명령은 LINE 그룹방에서만 사용할 수 있습니다.");
          continue;
        }

        const testResult = await pushToLineWithRetry(
          "REPAYMENT_TEST",
          testGroupId,
          buildPaymentRequestFlexMessage()
        );

        if (!testResult.ok) {
          await replyToLine(event.replyToken, `❌ 테스트 메시지 발송 실패\n\n${testResult.error || "발송 실패"}`);
        } else {
          await replyToLine(
            event.replyToken,
            "✅ 오늘상환요청 테스트 완료\n\n현재 그룹방에만 테스트 메시지를 발송했습니다.\n실제 고객 대상 조회 및 발송은 실행하지 않았습니다."
          );
        }
        continue;
      }

      const todayRepaymentBroadcastCommand = parseTodayRepaymentBroadcastCommand(commandText);
      if (todayRepaymentBroadcastCommand) {
        if (!isAdmin(event)) {
          await replyUnauthorized(event);
          continue;
        }

        const broadcastReply = await sendTodayRepaymentBroadcast(
          todayRepaymentBroadcastCommand.message,
          todayRepaymentBroadcastCommand.codePrefix
        );
        if (broadcastReply) {
          await replyToLineMessages(event.replyToken, [buildRepaymentAdminResultFlexMessage(broadcastReply)]);
        }
        continue;
      }

      const creditCheckCommand = parseCreditCheckCommand(commandText);
      if (creditCheckCommand) {
        if (!isAdmin(event)) {
          await replyUnauthorized(event);
          continue;
        }

        const { creditReplies, riskReply } = await buildCustomerCreditLookup(creditCheckCommand);
        await replyToLine(event.replyToken, creditReplies[0]);

        // 자동 영문이름 조회와 대화 위험 키워드 결과를 한 번의 추가 push 요청에 묶는다.
        // 메시지 객체가 여러 개여도 LINE은 같은 요청의 수신자 수를 기준으로 집계한다.
        const extraCreditMessages = [
          ...creditReplies.slice(1),
          riskReply
        ].filter(Boolean);
        if (extraCreditMessages.length) {
          const pushTargetId = getConversationKey(event);
          await pushToLineMessages(
            pushTargetId,
            extraCreditMessages.map(buildTextMessage)
          );
        }
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

        const groupMapping = await ensureCheckOverGroupMapping(event, checkOverCommand);
        if (!groupMapping.ok) {
          await replyToLine(event.replyToken, groupMapping.message || "⚠️ 고객방 그룹등록 상태를 확인하지 못했습니다.");
          continue;
        }

        const sourceGroupId = groupMapping.sourceGroupId || getLineSourceGroupId(event);
        const accessToken = SHEET_ID ? await getGoogleAccessToken() : null;
        const approvalGroupId = accessToken ? await getReceiptApprovalGroupId(accessToken) : null;
        const checkoverPendingId = makeCheckOverPendingId(checkOverCommand, sourceGroupId);
        checkOverCommand.checkoverPendingId = checkoverPendingId;
        if (accessToken) {
          await appendCheckOverPending(accessToken, {
            pendingId: checkoverPendingId,
            status: "pending",
            sourceGroupId,
            approvalGroupId,
            code: checkOverCommand.productCode,
            productAmount: checkOverCommand.productAmount,
            customerName: checkOverCommand.customerName,
            loanAmount: checkOverCommand.loanAmount,
            cut: checkOverCommand.cut,
            adminName: checkOverCommand.adminName
          });
        }
        const confirmMessages = buildCheckOverConfirmMessages(checkOverCommand, { sourceGroupId });

        // Check Over 때문에 자동으로 코드/등록이 실행된 경우,
        // 고객방에도 먼저 그룹등록 안내를 보여준 뒤 Check Over 확인 메시지와 등록 버튼을 이어서 보여준다.
        // 이미 같은 코드로 등록된 고객방이면 안내는 생략하고 기존처럼 바로 확인 메시지/버튼만 표시한다.
        const replyMessages = groupMapping.autoRegistered && groupMapping.autoRegisterReply
          ? [buildTextMessage(groupMapping.autoRegisterReply), ...confirmMessages]
          : confirmMessages;

        await replyToLineMessages(event.replyToken, replyMessages);
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

      const closeCommand = parseCloseCommand(commandText);
      if (closeCommand) {
        if (!isAdmin(event)) {
          await replyUnauthorized(event);
          continue;
        }

        const closeReply = await closeSheetCustomer(closeCommand);
        if (Array.isArray(closeReply)) {
          await replyToLineMessages(event.replyToken, closeReply);
        } else {
          await replyToLine(event.replyToken, closeReply);
        }
        continue;
      }

      const countCommand = parseCountCommand(commandText);
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
