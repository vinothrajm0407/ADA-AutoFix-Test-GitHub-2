// Calls the ADA Tool's existing scan API from CI, waits for the result, and
// fails the workflow (exit code 1) if any accessibility violations are found.
// Only reuses endpoints that already exist for the normal web app — no new
// backend surface needed for this pilot.

const fs = require("fs");

const BASE = process.env.ADA_API_BASE;
const API_KEY = process.env.ADA_API_KEY;
const SITE_URL = process.env.ADA_SITE_URL;

if (!BASE || !API_KEY || !SITE_URL) {
  console.error("Missing one of ADA_API_BASE / ADA_API_KEY / ADA_SITE_URL");
  process.exit(1);
}

// The 4 Assistive Testing modules — separate from the axe-core scan above,
// each its own existing endpoint in the app. No Auto-Fix exists for these
// (they're not element-level violations the same way axe rules are), so
// this only reports pass/fail, same as the app's own Assistive Testing tab.
const ASSISTIVE_MODULES = [
  { key: "keyboard", path: "/api/assisted/keyboard", label: "Keyboard Navigation" },
  { key: "contrast", path: "/api/assisted/color-contrast", label: "Color Contrast" },
  { key: "page-structure", path: "/api/assisted/page-structure", label: "Page Structure" },
  { key: "forms", path: "/api/assisted/forms", label: "Forms Accessibility" },
];

// The pilot's API base is an ngrok tunnel to a local dev machine — this
// header skips ngrok's free-tier "confirm you trust this link" interstitial,
// which a fresh CI runner (never seen by that tunnel before) could otherwise
// hit on every request. Harmless on a real hosted backend later.
const NGROK_HEADER = { "ngrok-skip-browser-warning": "true" };

// A tunnel/proxy hiccup (e.g. ngrok's HTML error page) must fail ONE call, not
// crash the whole run and skip every remaining rule and module.
async function readJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: `Non-JSON response (HTTP ${res.status}): ${text.slice(0, 80).replace(/\s+/g, " ")}` };
  }
}

// Keeps a code/HTML snippet from breaking the Markdown table/comment it's
// embedded in (a `|` would split a table cell, a stray ``` would close the
// code fence early).
function escapeForMarkdown(text) {
  return (text || "").replace(/\|/g, "\\|").replace(/```/g, "'''");
}

function truncate(text, max = 300) {
  if (!text) return "";
  return text.length <= max ? text : text.slice(0, max) + "…";
}

// Builds the collapsible "Full technical details" section — one block per
// violated rule with its plain-English description, WCAG mapping, and a few
// real example elements (selector + HTML + axe's own fix guidance), so the
// same comment works as a quick skim for anyone and a complete technical
// record for a developer, without needing a separate report file.
function buildDetailSection(violations) {
  const parts = [`<details>`, `<summary><strong>Full technical details</strong> — click to expand</summary>`, ``];
  for (const v of violations) {
    const wcagTags = (v.tags || []).filter((t) => /^wcag\d/.test(t));
    const nodes = v.nodes || [];
    parts.push(
      `#### \`${v.id}\` — ${escapeForMarkdown(v.help || v.description || "")}`,
      ``,
      `**Impact:** ${v.impact || "minor"} &nbsp;·&nbsp; **Elements affected:** ${nodes.length} &nbsp;·&nbsp; **WCAG:** ${wcagTags.join(", ") || "—"}`,
      ``,
      v.description ? `> ${escapeForMarkdown(v.description)}` : "",
      ``
    );
    const examples = nodes.slice(0, 3);
    for (const node of examples) {
      const selector = Array.isArray(node.target) ? node.target.join(", ") : node.target;
      parts.push(`<details>`, `<summary>Example: <code>${escapeForMarkdown(selector || "element")}</code></summary>`, ``);
      if (node.html) parts.push("```html", truncate(node.html, 300), "```");
      if (node.failureSummary) parts.push(``, `_${escapeForMarkdown(truncate(node.failureSummary, 300))}_`);
      parts.push(``, `</details>`, ``);
    }
    if (nodes.length > examples.length) {
      parts.push(`_…and ${nodes.length - examples.length} more element(s) affected by this rule._`, ``);
    }
    if (v.helpUrl) parts.push(`[Full rule documentation](${v.helpUrl})`, ``);
    parts.push(`---`, ``);
  }
  parts.push(`</details>`);
  return parts.join("\n");
}

// Turns a raw URL into a friendly page name for non-technical readers,
// e.g. "https://site.com/" -> "Home Page", ".../contact-us" -> "Contact Us".
function derivePageName(url) {
  try {
    const path = new URL(url).pathname.replace(/\/$/, "");
    if (!path) return "Home Page";
    const slug = path.split("/").filter(Boolean).pop();
    return slug.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  } catch {
    return url;
  }
}

// Posts the scan summary as a comment on the triggering PR, using the
// GITHUB_TOKEN GitHub Actions already provides automatically — no extra
// secret needed. No-op if this run wasn't triggered by a pull_request.
async function postPrComment(markdown) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY; // "owner/repo"
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!token || !repo || !eventPath) return;

  const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
  const prNumber = event.pull_request?.number;
  if (!prNumber) return; // not a PR run (e.g. a push to main)

  const res = await fetch(`https://api.github.com/repos/${repo}/issues/${prNumber}/comments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body: markdown }),
  });
  if (!res.ok) {
    console.error("Could not post PR comment:", res.status, await res.text());
  }
}

// Runs the existing Auto-Fix pipeline for one violated rule (clone, patch,
// build, re-scan, push a branch, open a PR) — same endpoint the app's own
// "Fix All" button calls. Auto-Fix only ever proposes a PR, it never merges,
// so this never changes the site itself without a human reviewing first.
async function autoFixRule(authHeaders, violation) {
  const totalNodes = violation.nodes?.length || 1;
  const res = await fetch(`${BASE}/api/auto-fix-batch`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      page_url: SITE_URL,
      rule: { id: violation.id, description: violation.description },
      nodes: violation.nodes,
    }),
  });
  const data = await readJson(res);
  if (!data.ok) {
    return { rule: violation.id, pr_url: null, totalNodes, patchedCount: 0, reasons: [data.error || `HTTP ${res.status}`] };
  }
  // `results` has one entry per element (patched/already_fixed/failed, each
  // with its own `error` when failed) — collecting the distinct reasons is
  // what lets us say *why* unfixed elements weren't fixed, not just that
  // they weren't.
  if (data.duplicate) {
    // A PR for this rule is already open from a previous run — nothing new
    // was patched just now, so "0 of N" would misleadingly read as a
    // failure when it's actually fully covered already.
    return { rule: violation.id, pr_url: data.pr_url || null, totalNodes, patchedCount: totalNodes, reasons: [] };
  }
  const results = data.results || [];
  const patchedCount = results.filter((r) => r.status === "patched" || r.status === "already_fixed").length;
  const reasons = [...new Set(results.filter((r) => r.status === "failed").map((r) => r.error).filter(Boolean))];
  if (!results.length && data.error) reasons.push(data.error);
  return { rule: violation.id, pr_url: data.pr_url || null, totalNodes, patchedCount, reasons };
}

// Runs one Assistive Testing module (keyboard/contrast/page-structure/forms)
// against the site and returns its pass/fail plus any failed checks' labels
// and details, same shape the app's own Assistive Testing tab already shows.
async function runAssistiveModule(authHeaders, mod) {
  try {
    const res = await fetch(`${BASE}${mod.path}`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ url: SITE_URL }),
    });
    const data = await readJson(res);
    if (!data.ok) {
      return { ...mod, passed: false, error: data.error || `HTTP ${res.status}`, failedChecks: [] };
    }
    const checks = data.result?.checks || [];
    const failedChecks = checks.filter((c) => !c.passed);
    return { ...mod, passed: !!data.result?.passed, failedChecks, error: null, raw: data.result };
  } catch (err) {
    return { ...mod, passed: false, error: err.message, failedChecks: [] };
  }
}

// ---- Assistive Auto-Fix --------------------------------------------------
// Mirrors the app's Assistive Testing "Auto Fix" button (src/utils/
// assistiveFixAdapter.js + the three *Module.jsx files): each failed issue is
// turned into an axe-style rule and sent to POST /api/auto-fix, one issue per
// call (one clone/build/re-scan/PR each). Capped per module so a noisy page
// can't open dozens of PRs in one run.
const MAX_ASSISTIVE_FIXES_PER_MODULE = 5;

function slug(str) {
  return (str || "issue").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 60);
}

function assistiveRule(testType, message, detail, severity, ruleId) {
  // Same shape as buildAssistiveViolation(); id is used inside a git branch
  // name, so no ':' etc. A real axe ruleId (when the check wraps one) unlocks
  // the free deterministic fixers instead of a Gemini call.
  return {
    id: ruleId || `assistive-${testType}-${slug(message)}`,
    description: message,
    help: message,
    detail,
    impact: severity === "error" ? "serious" : "moderate",
    sourceScanId: "assistive", // marks the PR/branch as an Assistive Testing fix
  };
}

function collectAssistiveFixes(mod, raw) {
  const out = [];
  if (!raw) return out;
  if (mod.key === "contrast") {
    for (const item of raw.groupedTargets || raw.affectedSamples || []) {
      const required = item.ratio?.required ?? 4.5;
      const hasColors = item.fgColor && item.bgColor;
      out.push({
        label: `Insufficient color contrast: ${item.target}`,
        rule: assistiveRule("contrast", `Insufficient color contrast${item.summary ? `: ${item.summary}` : ""}`,
          `Current ratio ${item.ratio?.current ?? "?"}, required ${required}:1`, "error", "color-contrast"),
        node: {
          html: item.html || "",
          target: item.target ? [item.target] : [],
          any: hasColors ? [{ data: { fgColor: item.fgColor, bgColor: item.bgColor, expectedContrastRatio: `${required}:1` } }] : [],
        },
      });
    }
  } else if (mod.key === "page-structure") {
    const ruleIds = { skipped_level: "heading-order", no_h1: "page-has-heading-one", unlabelled_navs: "landmark-unique" };
    for (const i of [...(raw.headingIssues || []), ...(raw.landmarkIssues || [])]) {
      out.push({
        label: i.message,
        rule: assistiveRule("page_structure", i.message, i.detail, i.severity, ruleIds[i.type]),
        node: { html: i.html || "" },
      });
    }
  } else if (mod.key === "forms") {
    for (const i of raw.issues || []) {
      out.push({
        label: i.message,
        rule: assistiveRule("forms", i.message, i.detail, i.severity, i.type === "missing_label" ? "label" : undefined),
        node: { html: i.html || "", target: i.selector ? [i.selector] : [] },
      });
    }
  }
  return out;
}

async function autoFixAssistive(authHeaders, fix) {
  try {
    const res = await fetch(`${BASE}/api/auto-fix`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ page_url: SITE_URL, rule: fix.rule, node: fix.node }),
    });
    const data = await readJson(res);
    if (!data.ok) return { label: fix.label, pr_url: null, reason: data.error || `HTTP ${res.status}` };
    if (data.status === "already_fixed") return { label: fix.label, pr_url: null, reason: "Already fixed in the source" };
    if (data.pr_url) return { label: fix.label, pr_url: data.pr_url, reason: null };
    const failed = (data.steps || []).filter((s) => !s.ok).map((s) => `${s.name}: ${s.detail}`);
    return { label: fix.label, pr_url: null, reason: data.error || failed.join("; ") || "Unknown reason" };
  } catch (err) {
    return { label: fix.label, pr_url: null, reason: err.message };
  }
}

async function main() {
  const authHeaders = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json", ...NGROK_HEADER };

  const scanRes = await fetch(`${BASE}/api/scan`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ url: SITE_URL }),
  });
  const scanData = await scanRes.json();
  if (!scanData.ok) {
    console.error("Could not start scan:", scanData.error || scanRes.status);
    process.exit(1);
  }
  const jobId = scanData.jobId;
  console.log(`Scan started for ${SITE_URL} (job ${jobId})`);

  const deadline = Date.now() + 120_000;
  let job = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2500));
    const statusRes = await fetch(`${BASE}/api/scan/${jobId}`, { headers: authHeaders });
    const statusData = await statusRes.json();
    if (!statusData.ok) continue;
    job = statusData.job;
    if (job.status === "completed" || job.status === "failed") break;
  }

  if (!job || job.status !== "completed") {
    const msg = `Scan did not complete in time: ${job ? job.status : "no response"}`;
    console.error(msg);
    await postPrComment(`### ❌ ADA Tool accessibility scan\n${msg}`);
    process.exit(1);
  }

  const violations = job.result?.axeResult?.violations || [];
  const totalElements = violations.reduce((sum, v) => sum + (v.nodes?.length || 1), 0);

  console.log(`\nAccessibility scan result for ${SITE_URL}`);
  console.log(`Rules violated: ${violations.length} | Elements affected: ${totalElements}\n`);
  for (const v of violations) {
    console.log(`  [${v.impact}] ${v.id} — ${v.nodes?.length || 1} element(s)`);
  }

  const passed = violations.length === 0;
  const critical = violations.filter((v) => v.impact === "critical").length;
  const serious = violations.filter((v) => v.impact === "serious").length;
  const pageName = derivePageName(SITE_URL);

  const lines = [
    `### ${passed ? "✅" : "❌"} ADA Tool accessibility scan — ${pageName}`,
    ``,
    passed
      ? `No accessibility problems found on this page. 🎉`
      : `**${pageName}** has **${violations.length} accessibility problem${violations.length === 1 ? "" : "s"}** — ${critical} critical (must fix) and ${serious} serious (should fix) — affecting **${totalElements} element${totalElements === 1 ? "" : "s"}** on the page (e.g. buttons, images, links). These could make the page harder or impossible to use for people with disabilities (screen reader users, keyboard-only users, low-vision users, etc.).`,
    ``,
    `**Page scanned:** [${pageName}](${SITE_URL})`,
    ``,
  ];
  if (!passed) {
    lines.push(
      `> "Critical" means this blocks some users from using the page at all. "Serious" means it makes the page significantly harder to use, but not impossible.`,
      ``
    );
    lines.push(`| Impact | Problem | Where |`);
    lines.push(`|---|---|---|`);
    for (const v of violations) {
      lines.push(`| ${v.impact} | ${v.id} | ${v.nodes?.length || 1} element(s) |`);
    }
    lines.push(``, buildDetailSection(violations));

    console.log("\nRunning Auto-Fix for each violated rule...");
    const fixResults = [];
    for (const v of violations) {
      const r = await autoFixRule(authHeaders, v);
      fixResults.push(r);
      // CLI/log output: the full reason, right here, not just pass/fail —
      // this is what shows up in the Actions run log for anyone who opens it.
      if (r.pr_url) {
        console.log(`  Auto-Fix: ${r.rule} -> PR opened (${r.patchedCount}/${r.totalNodes} elements): ${r.pr_url}`);
      } else {
        console.log(`  Auto-Fix: ${r.rule} -> NOT fixed. Reason(s): ${r.reasons.join("; ") || "unknown"}`);
      }
    }
    const opened = fixResults.filter((r) => r.pr_url);
    const notFixed = fixResults.filter((r) => !r.pr_url);

    lines.push(``, `#### 🛠️ Auto-Fix`);
    if (opened.length > 0) {
      lines.push(
        ``,
        `Auto-Fix opened ${opened.length} pull request${opened.length === 1 ? "" : "s"} with proposed fixes — ` +
          `**nothing is merged automatically**, a human still has to review and approve each one.`,
        ``
      );
      for (const r of opened) {
        const partial = r.patchedCount < r.totalNodes ? ` (${r.patchedCount}/${r.totalNodes} elements fixed)` : "";
        lines.push(`- [${r.rule}](${r.pr_url})${partial}`);
      }
    }
    if (notFixed.length > 0) {
      lines.push(
        ``,
        `**Not yet fixed (${notFixed.length} rule${notFixed.length === 1 ? "" : "s"}):**`,
        ``,
        `| Rule | Why it wasn't fixed |`,
        `|---|---|`
      );
      for (const r of notFixed) {
        lines.push(`| ${r.rule} | ${(r.reasons.join("; ") || "Unknown reason").replace(/\|/g, "\\|")} |`);
      }
    }
  }

  console.log("\nRunning Assistive Testing modules...");
  const assistiveResults = [];
  for (const mod of ASSISTIVE_MODULES) {
    const r = await runAssistiveModule(authHeaders, mod);
    assistiveResults.push(r);
    if (r.error) {
      console.log(`  ${r.label} -> could not run: ${r.error}`);
    } else {
      console.log(`  ${r.label} -> ${r.passed ? "PASSED" : `FAILED (${r.failedChecks.length} check(s))`}`);
    }
  }
  const assistiveFailed = assistiveResults.filter((r) => !r.passed);

  lines.push(``, `#### 🧪 Assistive Testing`, ``);
  lines.push(`| Module | Result |`);
  lines.push(`|---|---|`);
  for (const r of assistiveResults) {
    const status = r.error ? `⚠️ Could not run (${r.error})` : r.passed ? "✅ Passed" : `❌ Failed (${r.failedChecks.length} check(s))`;
    lines.push(`| ${r.label} | ${status} |`);
  }
  const failedWithChecks = assistiveResults.filter((r) => !r.passed && !r.error && r.failedChecks.length);
  if (failedWithChecks.length > 0) {
    lines.push(``, `**Details:**`, ``);
    for (const r of failedWithChecks) {
      for (const c of r.failedChecks) {
        lines.push(`- **${r.label}** — ${c.label || c.id}: ${c.details || "no detail given"}`);
      }
    }
  }

  // Auto-Fix for failed Assistive Testing issues (same pipeline as the app's
  // Assistive Testing "Auto Fix" button). Opens PRs only, never merges.
  if (assistiveFailed.some((r) => !r.error)) {
    console.log("\nRunning Auto-Fix for failed Assistive Testing issues...");
    const assistiveFixLines = [];
    for (const r of assistiveResults.filter((x) => !x.passed && !x.error)) {
      const all = collectAssistiveFixes(r, r.raw);
      const todo = all.slice(0, MAX_ASSISTIVE_FIXES_PER_MODULE);
      if (!todo.length) continue;
      assistiveFixLines.push(`**${r.label}**${all.length > todo.length ? ` (first ${todo.length} of ${all.length} issues)` : ""}`, ``);
      for (const fix of todo) {
        const f = await autoFixAssistive(authHeaders, fix);
        if (f.pr_url) {
          console.log(`  Assistive Auto-Fix [${r.label}] ${f.label} -> PR opened: ${f.pr_url}`);
          assistiveFixLines.push(`- ✅ ${escapeForMarkdown(f.label)} → [PR](${f.pr_url})`);
        } else {
          console.log(`  Assistive Auto-Fix [${r.label}] ${f.label} -> NOT fixed. Reason: ${f.reason}`);
          assistiveFixLines.push(`- ⚠️ ${escapeForMarkdown(f.label)} — ${escapeForMarkdown(truncate(f.reason, 200))}`);
        }
      }
      assistiveFixLines.push(``);
    }
    if (assistiveFixLines.length) {
      lines.push(``, `#### 🛠️ Assistive Testing Auto-Fix`, ``, `PRs only — nothing is merged automatically.`, ``, ...assistiveFixLines);
    }
  }

  let summary = lines.join("\n");
  // GitHub caps a single comment at 65,536 characters — with many violated
  // rules each carrying full HTML examples, a real page can get close. Trim
  // from the end (the detail section) rather than fail the post outright.
  const COMMENT_LIMIT = 60000;
  if (summary.length > COMMENT_LIMIT) {
    summary = summary.slice(0, COMMENT_LIMIT) + "\n\n…_(truncated — see the full log in the Actions run for everything)_";
  }
  await postPrComment(summary);

  // GitHub's built-in Job Summary — shows this same content right on the
  // workflow run page and the PR's Checks tab, no need to open the raw log
  // or scroll a comment thread to see what happened.
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
  }

  if (!passed || assistiveFailed.length > 0) {
    if (!passed) console.log(`\n❌ Accessibility scan found ${totalElements} issue(s) across ${violations.length} rule(s).`);
    if (assistiveFailed.length > 0) console.log(`❌ ${assistiveFailed.length} Assistive Testing module(s) failed.`);
    process.exit(1);
  }
  console.log("\n✅ No accessibility violations found, all Assistive Testing modules passed.");
}

main().catch((err) => {
  console.error("Scan script crashed:", err);
  process.exit(1);
});
