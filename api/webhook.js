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
const GROUP_MAP_SHEET_NAME = process.env.LINE_GROUP_MAP_SHEET_NAME || "LINE그룹매핑";
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || "")
  .split(",")
  .map(v => v.trim())
  .filter(Boolean);

const LINE_CUSTOMER_START_ROW = 1058;
const LINE_CUSTOMER_START_INDEX0 = LINE_CUSTOMER_START_ROW - 1;

const REPAYMENT_MORNING_MESSAGE = `📌 กรุณาโอนชำระครับ

วันนี้เป็นวันชำระของคุณครับ
กรุณาโอนก่อนเวลา 20:00 น. ของวันนี้`;

const REPAYMENT_AFTERNOON_MESSAGE = `📌 กรุณาโอนชำระด่วนครับ

ขณะนี้ยังไม่พบรายการชำระของคุณครับ

กรุณารีบดำเนินการโอนโดยเร็วที่สุด
และส่งสลิปหลังโอนเสร็จครับ`;

const PAYMENT_REQUEST_MESSAGE = `📌 กรุณาโอนชำระครับ`;


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
  const match = clean.match(/^([A-Za-z]{2,3}\d{2,3})\/(\d+(?:\.\d+)?)$/);
  if (!match) return null;

  return {
    code: match[1].toUpperCase(),
    value: match[2]
  };
}

function parseRegisterGroupCommand(text) {
  const clean = normalizeText(text).replace(/\s+/g, "");
  const match = clean.match(/^([A-Za-z]{1,3}\d{1,3})\/등록$/);
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

function parseNewCustomerRegisterCommand(text) {
  const normalized = normalizeText(text);
  const lines = normalized
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return null;
  if (lines[0].replace(/\s+/g, "") !== "등록") return null;

  const data = {};
  for (const line of lines.slice(1)) {
    const match = line.match(/^([^:：]+)[:：](.*)$/);
    if (!match) continue;
    const key = match[1].trim().replace(/\s+/g, "");
    const value = match[2].trim();
    data[key] = value;
  }

  const requiredKeys = ["년/월", "상태", "구분", "관리자명", "상품명", "고객명", "날짜", "금액", "Cut"];
  const missing = requiredKeys.filter(key => !data[key]);
  if (missing.length > 0) {
    return { error: `⚠️ 등록 양식 누락: ${missing.join(", ")}` };
  }

  const normalizedYearMonth = parseYearMonthValue(data["년/월"]);
  if (!normalizedYearMonth) {
    return { error: "⚠️ 년/월은 2606 또는 26/06 형식으로 입력해주세요." };
  }

  const dateMatch = data["날짜"].match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!dateMatch) return { error: "⚠️ 날짜는 5/30 형식으로 입력해주세요." };

  const month = Number(dateMatch[1]);
  const day = Number(dateMatch[2]);
  if (!Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12 || day < 1 || day > 31) {
    return { error: "⚠️ 날짜 값이 올바르지 않습니다." };
  }

  const yearMonthMonth = Number(normalizedYearMonth.slice(2, 4));
  if (month !== yearMonthMonth) {
    return { error: `⚠️ 년/월(${normalizedYearMonth})과 날짜(${data["날짜"]})의 월이 다릅니다.` };
  }

  const fullYear = getFullYearFromYearMonth(normalizedYearMonth);
  const lastDayOfMonth = getDaysInMonth(fullYear, month);
  if (day > lastDayOfMonth) {
    return { error: `⚠️ ${fullYear}년 ${month}월은 ${lastDayOfMonth}일까지 있습니다. 날짜를 다시 확인해주세요.` };
  }

  const amountMatch = data["상품명"].match(/\(([\d,]+)\)/);
  if (!amountMatch) return { error: "⚠️ 상품명 괄호 안 상품금액을 찾지 못했습니다. 예: JB22(130,000)" };

  const productAmount = Number(amountMatch[1].replace(/,/g, ""));
  if (!Number.isFinite(productAmount)) return { error: "⚠️ 상품금액을 숫자로 인식하지 못했습니다." };

  const amountParsed = parseNumericRequiredValue(data["금액"], "금액");
  if (amountParsed.error) return amountParsed;

  const cutParsed = parseCutRequiredValue(data["Cut"]);
  if (cutParsed.error) return cutParsed;

  return {
    yearMonth: normalizedYearMonth,
    status: data["상태"],
    type: data["구분"],
    adminName: data["관리자명"],
    productName: data["상품명"],
    customerName: data["고객명"],
    dateText: data["날짜"],
    fullYear,
    month,
    lastDayOfMonth,
    startDay: day,
    amount: amountParsed.value,
    cut: cutParsed.value,
    productAmount
  };
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

function getNextCustomerNumber(values) {
  let maxNo = 0;
  for (const row of values.slice(1)) {
    const no = Number(String(row?.[0] || "").trim());
    if (Number.isFinite(no)) maxNo = Math.max(maxNo, no);
  }
  return maxNo + 1;
}

async function registerNewCustomer(command) {
  if (command?.error) return command.error;
  if (!SHEET_ID) {
    return "⚠️ GOOGLE_SHEET_ID 환경변수가 설정되지 않았습니다.";
  }

  const repayment = buildRepaymentCells(command);
  if (repayment.error) return repayment.error;

  const accessToken = await getGoogleAccessToken();
  const values = await getSheetValues(accessToken);
  const nextNo = getNextCustomerNumber(values);
  const nextRowNumber = values.length + 1;

  const topRow = Array(DATE_END_COLUMN_INDEX + 1).fill("");
  const bottomRow = Array(DATE_END_COLUMN_INDEX + 1).fill("");

  topRow[0] = nextNo;
  topRow[1] = command.yearMonth;
  topRow[2] = command.status;
  topRow[3] = command.type;
  topRow[4] = command.adminName;
  topRow[5] = command.productName;
  topRow[6] = command.customerName;
  topRow[7] = command.dateText;
  topRow[8] = formatAmountValue(command.amount);
  topRow[9] = `=I${nextRowNumber}+SUM(L${nextRowNumber}:AP${nextRowNumber + 1})`;
  topRow[10] = `=J${nextRowNumber}*0.7`;

  bottomRow[10] = `=J${nextRowNumber}*0.3`;
  repayment.cells.forEach((value, index) => {
    bottomRow[DATE_START_COLUMN_INDEX + index] = value;
  });

  await appendSheetRows(accessToken, [topRow, bottomRow]);

  const startMessage = repayment.noCut && repayment.plan.intervalDays === 1
    ? `${command.startDay}일은 -, 다음날부터 매일 ${repayment.plan.repaymentCount}회`
    : `${command.startDay}일부터 ${repayment.plan.intervalDays}일 간격 ${repayment.plan.repaymentCount}회`;

  return `✅ 신규 고객 등록완료\n${command.productName}\n${command.customerName}\n상환표시: ${startMessage}`;
}

async function getSpreadsheetSheetTitles(accessToken) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?fields=sheets.properties.title`;
  const response = await axios.get(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  return (response.data.sheets || []).map(sheet => sheet.properties?.title).filter(Boolean);
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
  for (let i = 1; i < values.length; i += 1) {
    const code = String(values[i]?.[0] || "").trim().toUpperCase();
    if (code === command.code) {
      existingRowNumber = i + 1;
      break;
    }
  }

  if (existingRowNumber) {
    const range = `'${escapeSheetName(GROUP_MAP_SHEET_NAME)}'!A${existingRowNumber}:C${existingRowNumber}`;
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
    await axios.put(
      url,
      { range, majorDimension: "ROWS", values: [[command.code, groupId, nowText]] },
      { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }
    );
  } else {
    const range = `'${escapeSheetName(GROUP_MAP_SHEET_NAME)}'!A:C`;
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
    await axios.post(
      url,
      { range, majorDimension: "ROWS", values: [[command.code, groupId, nowText]] },
      { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }
    );
  }

  return "✅ 등록완료";
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

async function pushToLine(to, text) {
  return axios.post(
    "https://api.line.me/v2/bot/message/push",
    {
      to,
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

function parseTodayRepaymentBroadcastCommand(text) {
  const clean = normalizeText(text).replace(/\s+/g, "");

  if (clean === "오늘입금요청") {
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

function findTodayDollarCodes(values) {
  const today = getKoreaToday();
  const todayColumnIndex0 = findTodayColumnIndex(values, today.day);
  const codes = [];
  const seen = new Set();

  // 라인 그룹 고객은 1058행부터 시작하고, 고객 1명당 2행씩 사용함
  // 1058~1059 = 1명, 1060~1061 = 1명... 구조만 검색
  for (let i = LINE_CUSTOMER_START_INDEX0; i < values.length; i += 2) {
    const row = values[i] || [];
    const status = String(row[2] || "").trim(); // C열 상태
    const productName = String(row[5] || "").trim(); // F열 상품명

    if (status !== "진행중") continue;

    const code = extractCustomerCodeFromProductName(productName);
    if (!code) continue;

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
  const codes = findTodayDollarCodes(values);

  if (!codes.length) {
    return "⚠️ 오늘 발송 대상이 없습니다.";
  }

  const failedCodes = [];

  for (const code of codes) {
    const groupId = await findMappedGroupId(accessToken, code);
    if (!groupId) {
      failedCodes.push(code);
      continue;
    }

    try {
      await pushToLine(groupId, broadcastMessage);
    } catch (err) {
      console.error(err);
      failedCodes.push(code);
    }
  }

  if (failedCodes.length) {
    return `❌ 그룹을 찾을 수 없습니다.\n\n${failedCodes.join("\n")}`;
  }

  return null; // 전부 성공 시 관리자방에는 답장하지 않음
}


export async function runRepaymentMorningCron() {
  return await sendTodayRepaymentBroadcast(REPAYMENT_MORNING_MESSAGE);
}

export async function runRepaymentAfternoonCron() {
  return await sendTodayRepaymentBroadcast(REPAYMENT_AFTERNOON_MESSAGE);
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

  const newInputCandidates = [];
  const sumCandidates = [];

  // 1순위: 하이픈(-) 또는 달러($) 칸은 신규 입력 가능
  // 2순위: 숫자 칸은 추가 입금 시 기존값 + 신규값으로 합산 가능
  // 공백, X, 기타 문자는 자동 입력 대상에서 제외
  if (isInputCandidateCell(topToday)) {
    newInputCandidates.push({ rowNumber: topIndex0 + 1, currentValue: topToday });
  } else if (isActualPaymentCell(topToday)) {
    sumCandidates.push({ rowNumber: topIndex0 + 1, currentValue: topToday });
  }

  if (isInputCandidateCell(bottomToday)) {
    newInputCandidates.push({ rowNumber: topIndex0 + 2, currentValue: bottomToday });
  } else if (isActualPaymentCell(bottomToday)) {
    sumCandidates.push({ rowNumber: topIndex0 + 2, currentValue: bottomToday });
  }

  if (newInputCandidates.length === 1) {
    return { status: "ok", mode: "new", ...newInputCandidates[0] };
  }

  if (newInputCandidates.length >= 2) {
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

    return `✅ ${command.code} : ${currentText} + ${addText} = ${totalText}`;
  }

  const inputText = formatAmountValue(command.value);
  await updateSheetCell(accessToken, target.rowNumber, todayColumnIndex0, inputText);

  return `✅ ${command.code} : ${inputText} 등록완료`;
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
  "답장해주세요": "ช่วยตอบแชทด้วยครับ"
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

  return /[📌✅🔥💸✔️🔔⚠️📍🚨🆘❗‼️⛔]/u.test(clean) || /sos/i.test(clean);
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

      const text = normalizeText(event.message.text);
      if (!text) continue;

      const newCustomerRegisterCommand = parseNewCustomerRegisterCommand(text);
      if (newCustomerRegisterCommand) {
        if (!isAdmin(event)) {
          await replyUnauthorized(event);
          continue;
        }

        const registerReply = await registerNewCustomer(newCustomerRegisterCommand);
        await replyToLine(event.replyToken, registerReply);
        continue;
      }

      if (parseMyIdCommand(text)) {
        const userId = getLineUserId(event);
        await replyToLine(event.replyToken, userId ? `내아이디\n${userId}` : "⚠️ userId를 확인할 수 없습니다.");
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
