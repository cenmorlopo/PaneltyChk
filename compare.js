const axios = require("axios");
const fs = require("fs");
const path = require("path");

/*
INPUT FILE:
result_students.txt

FORMAT:
reg_no | back_codes | back_names

Example:
23104134010 | 100202,103202 | ENGINEERING GRAPHICS & DESIGN,MATHEMATICS - II
*/

const CONFIG = {
  backendYear: "2025",
  semester: "II",
  examHeld: "November/2025",

  frontendName: "B.Tech. 2nd Semester Examination, 2025 (Old)",
  frontendSession: "2025",

  timeoutMs: 30000,
  maxRetries: 3,
  retryDelayMs: 1500,
  politeDelayMs: 900,
  maxRuntimeMs: 5 * 60 * 60 * 1000
};

const FILES = {
  input: path.join(__dirname, "result_students.txt"),
  output: path.join(__dirname, "compare_results.txt"),
  summary: path.join(__dirname, "compare_summary.txt"),
  log: path.join(__dirname, "compare_run.log"),
  state: path.join(__dirname, "compare_state.json"),
  seen: path.join(__dirname, "compare_seen.txt"),
  failed: path.join(__dirname, "compare_failed_regnos.txt")
};

function ensureFile(filePath, defaultContent = "") {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, defaultContent, "utf8");
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  fs.appendFileSync(FILES.log, line + "\n", "utf8");
}

function normalizeText(v) {
  return String(v || "").trim();
}

function parseNumber(raw) {
  const cleaned = String(raw || "").replace(/[^\d.]/g, "");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function hasGrace(raw) {
  return String(raw || "").includes("*");
}

function buildBackendUrl(regNo) {
  const u = new URL("https://beu-bih.ac.in/backend/v1/result/get-result");
  u.searchParams.set("year", CONFIG.backendYear);
  u.searchParams.set("redg_no", regNo);
  u.searchParams.set("semester", CONFIG.semester);
  u.searchParams.set("exam_held", CONFIG.examHeld);
  return u.toString();
}

function buildFrontendUrl(regNo) {
  const u = new URL("https://beu-bih.ac.in/result-three");
  u.searchParams.set("name", CONFIG.frontendName);
  u.searchParams.set("semester", CONFIG.semester);
  u.searchParams.set("session", CONFIG.frontendSession);
  u.searchParams.set("regNo", regNo);
  u.searchParams.set("exam_held", CONFIG.examHeld);
  return u.toString();
}

function loadState() {
  ensureFile(
    FILES.state,
    JSON.stringify({ lineIndex: 0, updatedAt: new Date().toISOString() }, null, 2)
  );
  try {
    return JSON.parse(fs.readFileSync(FILES.state, "utf8"));
  } catch {
    return { lineIndex: 0 };
  }
}

function saveState(lineIndex) {
  fs.writeFileSync(
    FILES.state,
    JSON.stringify({ lineIndex, updatedAt: new Date().toISOString() }, null, 2),
    "utf8"
  );
}

function loadSet(filePath) {
  ensureFile(filePath, "");
  return new Set(
    fs.readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .map(x => x.trim())
      .filter(Boolean)
  );
}

function appendUnique(filePath, setObj, value) {
  if (!setObj.has(value)) {
    fs.appendFileSync(filePath, value + "\n", "utf8");
    setObj.add(value);
  }
}

function loadInputRows() {
  if (!fs.existsSync(FILES.input)) {
    throw new Error(`Missing input file: ${FILES.input}`);
  }

  const rawLines = fs.readFileSync(FILES.input, "utf8").split(/\r?\n/);

  return rawLines
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !/^reg_no\s*\|/i.test(line))
    .map(line => {
      const parts = line.split("|");
      if (parts.length < 2) return null;

      const regNo = normalizeText(parts[0]);
      const backCodesRaw = normalizeText(parts[1]);

      if (!/^\d+$/.test(regNo)) return null;

      const backCodes = backCodesRaw
        .split(",")
        .map(x => x.trim())
        .filter(Boolean);

      return { regNo, backCodes };
    })
    .filter(Boolean);
}

async function fetchNewResult(regNo) {
  const url = buildBackendUrl(regNo);
  let delay = CONFIG.retryDelayMs;

  for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
    try {
      const response = await axios.get(url, {
        timeout: CONFIG.timeoutMs,
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": "application/json, text/plain, */*"
        },
        validateStatus: status => status >= 200 && status < 500
      });

      if (response.status !== 200) {
        return { kind: "ERROR", url, error: `HTTP ${response.status}` };
      }

      const data = response.data;
      if (!data || data.status !== 200 || !data.data) {
        return { kind: "ERROR", url, error: "Invalid JSON payload" };
      }

      return { kind: "FOUND", url, data: data.data };
    } catch (error) {
      if (attempt === CONFIG.maxRetries) {
        return { kind: "ERROR", url, error: error.message };
      }
      await sleep(delay);
      delay *= 2;
    }
  }

  return { kind: "ERROR", url, error: "Unknown fetch error" };
}

function gradeFromPercent(percent) {
  if (percent >= 90) return "A+";
  if (percent >= 80) return "A";
  if (percent >= 70) return "B";
  if (percent >= 60) return "C";
  if (percent >= 50) return "D";
  if (percent >= 35) return "P";
  return "F";
}

function oneStepLower(expected) {
  const map = {
    "A+": "A",
    "A": "B",
    "B": "C",
    "C": "D",
    "D": "P"
  };
  return map[expected] || null;
}

function classifySubject(subject, subjectType) {
  const code = normalizeText(subject.code);
  const name = normalizeText(subject.name);
  const eseRaw = normalizeText(subject.ese);
  const iaRaw = normalizeText(subject.ia);
  const totalRaw = normalizeText(subject.total);
  const actualGrade = normalizeText(subject.grade).toUpperCase();

  const eseNum = parseNumber(eseRaw);
  const iaNum = parseNumber(iaRaw);
  const totalNum = parseNumber(totalRaw);
  const grace = hasGrace(eseRaw);

  if (eseNum === null || totalNum === null || !actualGrade) {
    return {
      code,
      name,
      subjectType,
      eseRaw,
      ia: iaRaw,
      total: totalRaw,
      expectedGrade: "-",
      actualGrade: actualGrade || "-",
      status: "MANUAL_REVIEW",
      reason: "Missing or malformed fields"
    };
  }

  // Theory: total 100, ESE pass 35% of 70 => 24.5
  // Practical: total 50, ESE pass 35% of 30 => 10.5
  const totalMax = subjectType === "practical" ? 50 : 100;
  const esePassMin = subjectType === "practical" ? 10.5 : 24.5;
  const totalPassMin = totalMax * 0.35;

  const thresholdPass = grace || eseNum >= esePassMin;
  const percent = (totalNum / totalMax) * 100;

  let expectedGrade = "F";
  let thresholdReason = "";

  if (totalNum < totalPassMin) {
    expectedGrade = "F";
    thresholdReason = "Overall total below 35%";
  } else if (!thresholdPass) {
    expectedGrade = "F";
    thresholdReason = `ESE threshold not met for ${subjectType}`;
  } else {
    expectedGrade = gradeFromPercent(percent);
  }

  let status = "MANUAL_REVIEW";
  let reason = "";

  if (expectedGrade === actualGrade) {
    if (expectedGrade === "F") {
      if (thresholdReason) {
        status = "NO_PENALTY_THRESHOLD_FAIL";
        reason = thresholdReason;
      } else {
        status = "NO_PENALTY_STILL_FAILED";
        reason = "Expected F and actual F";
      }
    } else {
      status = "NO_PENALTY_CLEARED_CORRECTLY";
      reason = "Expected grade matches actual grade";
    }
  } else if (expectedGrade !== "F" && actualGrade === oneStepLower(expectedGrade)) {
    status = "PENALTY_SUSPECTED";
    reason = `Expected ${expectedGrade} but actual is exactly one step lower (${actualGrade})`;
  } else {
    status = "MANUAL_REVIEW";
    reason = `Expected ${expectedGrade}, actual ${actualGrade}`;
  }

  return {
    code,
    name,
    subjectType,
    eseRaw,
    ia: iaNum === null ? iaRaw : String(iaNum),
    total: totalNum === null ? totalRaw : String(totalNum),
    expectedGrade,
    actualGrade,
    status,
    reason
  };
}

function buildSubjectMaps(apiData) {
  const theory = new Map();
  const practical = new Map();

  for (const s of apiData.theorySubjects || []) {
    theory.set(normalizeText(s.code), s);
  }
  for (const s of apiData.practicalSubjects || []) {
    practical.set(normalizeText(s.code), s);
  }

  return { theory, practical };
}

function processStudent(apiData, regNo, backCodes) {
  const { theory, practical } = buildSubjectMaps(apiData);
  const frontendLink = buildFrontendUrl(regNo);
  const backendLink = buildBackendUrl(regNo);
  const studentName = normalizeText(apiData.name) || "-";

  const results = [];

  for (const code of backCodes) {
    const cleanCode = normalizeText(code);

    if (theory.has(cleanCode)) {
      const classified = classifySubject(theory.get(cleanCode), "theory");
      results.push({ regNo, studentName, ...classified, frontendLink, backendLink });
      continue;
    }

    if (practical.has(cleanCode)) {
      const classified = classifySubject(practical.get(cleanCode), "practical");
      results.push({ regNo, studentName, ...classified, frontendLink, backendLink });
      continue;
    }

    results.push({
      regNo,
      studentName,
      code: cleanCode,
      name: "-",
      subjectType: "-",
      eseRaw: "-",
      ia: "-",
      total: "-",
      expectedGrade: "-",
      actualGrade: "-",
      status: "MISSING_IN_NEW_RESULT",
      reason: "Old backlog code not found in new result JSON",
      frontendLink,
      backendLink
    });
  }

  return results;
}

function initOutputFiles() {
  ensureFile(FILES.output, "");
  ensureFile(FILES.summary, "");
  ensureFile(FILES.log, "");
  ensureFile(FILES.failed, "");
  ensureFile(FILES.seen, "");

  const current = fs.readFileSync(FILES.output, "utf8");
  if (!current.trim()) {
    fs.writeFileSync(
      FILES.output,
      "reg_no | student_name | subject_code | subject_name | subject_type | ese_raw | ia | total | expected_grade | actual_grade | status | reason | frontend_link\n",
      "utf8"
    );
  }
}

function appendOutputRows(rows) {
  const lines = rows.map(r =>
    [
      r.regNo,
      r.studentName,
      r.code,
      r.name,
      r.subjectType,
      r.eseRaw,
      r.ia,
      r.total,
      r.expectedGrade,
      r.actualGrade,
      r.status,
      r.reason,
      r.frontendLink
    ].join(" | ")
  );

  fs.appendFileSync(FILES.output, lines.join("\n") + "\n", "utf8");
}

function writeSummary(summaryObj) {
  const lines = [
    `total_students_in_input = ${summaryObj.totalStudents}`,
    `students_processed_this_run = ${summaryObj.studentsProcessed}`,
    `subject_rows_written_this_run = ${summaryObj.subjectRows}`,
    `penalty_suspected = ${summaryObj.penalty}`,
    `no_penalty_cleared_correctly = ${summaryObj.cleared}`,
    `no_penalty_still_failed = ${summaryObj.stillFailed}`,
    `no_penalty_threshold_fail = ${summaryObj.thresholdFail}`,
    `missing_in_new_result = ${summaryObj.missing}`,
    `manual_review = ${summaryObj.manual}`,
    `fetch_errors = ${summaryObj.fetchErrors}`
  ];
  fs.writeFileSync(FILES.summary, lines.join("\n") + "\n", "utf8");
}

async function run() {
  initOutputFiles();

  const state = loadState();
  const seen = loadSet(FILES.seen);
  const failed = loadSet(FILES.failed);
  const rows = loadInputRows();

  const startedAt = Date.now();

  const summary = {
    totalStudents: rows.length,
    studentsProcessed: 0,
    subjectRows: 0,
    penalty: 0,
    cleared: 0,
    stillFailed: 0,
    thresholdFail: 0,
    missing: 0,
    manual: 0,
    fetchErrors: 0
  };

  log(`Loaded ${rows.length} students from ${path.basename(FILES.input)}`);
  log(`Resuming from lineIndex=${state.lineIndex}`);

  for (let i = state.lineIndex; i < rows.length; i++) {
    if (Date.now() - startedAt > CONFIG.maxRuntimeMs) {
      log(`STOP max runtime reached`);
      saveState(i);
      writeSummary(summary);
      return;
    }

    const row = rows[i];
    const { regNo, backCodes } = row;
    const frontendLink = buildFrontendUrl(regNo);

    if (seen.has(regNo)) {
      log(`[${i + 1}/${rows.length}] ${regNo} -> DUP_ALREADY_PROCESSED -> ${frontendLink}`);
      saveState(i + 1);
      continue;
    }

    const fetched = await fetchNewResult(regNo);

    if (fetched.kind === "ERROR") {
      summary.fetchErrors++;
      appendUnique(FILES.failed, failed, regNo);
      log(`[${i + 1}/${rows.length}] ${regNo} -> ERR -> ${fetched.error} -> ${frontendLink}`);
      saveState(i + 1);
      await sleep(CONFIG.politeDelayMs);
      continue;
    }

    const subjectResults = processStudent(fetched.data, regNo, backCodes);
    appendOutputRows(subjectResults);
    appendUnique
