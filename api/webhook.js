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
  const match = clean.match(/^([A-Za-z]{1,3}\d{1,3})\/종료$/i);
  if (!match) return null;

  return {
    code: match[1].toUpperCase()
  };
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

function parseCutRequiredValue(value) {
  const raw = String(value ?? "").trim();
  if (raw === "-") return { value: "-" };
  const n = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(n)) {
    return { error: "⚠️ Cut은 숫자 또는 - 로 입력해주세요. 예: 5 또는 -" };
  }
  return { value: n };
}

function getRepaymentPlanByProductAmount(productAmount) {
  const plans = {
    130000: { intervalDays: 7, repaymentCount: 4 },
    195000: { intervalDays: 7, repaymentCount: 4 },
    25000: { intervalDays: 1, repaymentCount: 10 },
    40000: { intervalDays: 1, repaymentCount: 15 },
    45000: { intervalDays: 1, repaymentCount: 12 },
    50000: { intervalDays: 1, repaymentCount: 10 },
    55000: { intervalDays: 1, repaymentCount: 10 }
  };
  return plans[productAmount] || null;
}

function buildRepaymentCells(command) {
  const plan = getRepaymentPlanByProductAmount(command.productAmount);
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
    for (let i = 1; i <= plan.repaymentCount; i += 1) {
      const dueDay = command.startDay + plan.intervalDays * i;
      if (dueDay > lastDayOfMonth) continue;

      const dueIndex = dueDay - 1;
      if (dueIndex >= 0 && dueIndex < cells.length && isBlankCell(cells[dueIndex])) {
        cells[dueIndex] = "$";
      }
    }
  }

  return { cells, plan, lastDayOfMonth, noCut: isNoCut };
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

function findNextCustomerWriteRow(values) {
  // A:I, L:AP 기준으로 실제 고객 데이터가 있는 마지막 줄 바로 다음 줄을 사용한다.
  // append API는 빈 양식/공백줄을 건너뛰거나 새 행을 삽입해 위치가 밀릴 수 있어 직접 범위 업데이트한다.
  let lastContentIndex0 = 0; // 1행은 보통 헤더로 보고 최소 2행부터 입력

  for (let i = 1; i < values.length; i += 1) {
    if (hasCustomerRegisterContent(values[i])) {
      lastContentIndex0 = i;
    }
  }

  return Math.max(2, lastContentIndex0 + 2);
}

function getNextCustomerNumber(values) {
  let maxNo = 0;
  for (const row of values.slice(1)) {
    const no = Number(String(row?.[0] || "").trim());
    if (Number.isFinite(no)) maxNo = Math.max(maxNo, no);
  }
  return maxNo + 1;
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
  const values = await getGroupMapValues(accessToken);
  for (let i = 1; i < values.length; i += 1) {
    const code = String(values[i]?.[0] || "").trim().toUpperCase();
    const groupId = String(values[i]?.[1] || "").trim();
    if (code === codeToFind && groupId) return groupId;
  }
  return null;
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

// 오늘상환오전/오후/요청 발송 속도 설정
// 기존에는 1건씩 순차 발송 + 건별 대기시간으로 느렸기 때문에,
// 기본값을 병렬 발송으로 변경한다.
// 필요 시 환경변수 LINE_PUSH_CONCURRENCY로 동시 발송 개수를 조절 가능.
const LINE_PUSH_CONCURRENCY = Math.max(1, Number(process.env.LINE_PUSH_CONCURRENCY || 10));
const LINE_PUSH_DELAY_MS = Number(process.env.LINE_PUSH_DELAY_MS || 0);
const LINE_PUSH_RETRY_COUNT = Number(process.env.LINE_PUSH_RETRY_COUNT || 1);
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

async function replyUnauthorized(event) {
  await replyToLine(event.replyToken, "⛔ 권한이 없습니다.");
}

function extractCustomerCodeFromProductName(productName) {
  const match = String(productName || "").match(/([A-Za-z]{1,3}\d{1,3})/);
  return match ? match[1].toUpperCase() : null;
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
  await updateSheetCell(accessToken, topRowNumber, 2, "종료");
  await applyClosedCustomerStyle(accessToken, topRowNumber);

  return `✅ ${command.code} 종료 처리완료`;
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

  return /[📌📣✅🔥💸✔️🔔⚠️📍🚨🆘❗‼️⛔]/u.test(clean) || /sos/i.test(clean);
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

  if (containsNoTranslateAmount(clean)) return true;

  for (const keyword of ignoreKeywords) {
    if (clean.includes(keyword)) return true;
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

  for (const event of events) {
    try {
      if (event.type !== "message") continue;
      if (event.message.type !== "text") continue;

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
