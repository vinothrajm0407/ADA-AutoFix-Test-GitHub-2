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

// The pilot's API base is an ngrok tunnel to a local dev machine — this
// header skips ngrok's free-tier "confirm you trust this link" interstitial,
// which a fresh CI runner (never seen by that tunnel before) could otherwise
// hit on every request. Harmless on a real hosted backend later.
const NGROK_HEADER = { "ngrok-skip-browser-warning": "true" };

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
  }
  await postPrComment(lines.join("\n"));

  if (!passed) {
    console.log(`\n❌ Accessibility scan found ${totalElements} issue(s) across ${violations.length} rule(s).`);
    process.exit(1);
  }
  console.log("\n✅ No accessibility violations found.");
}

main().catch((err) => {
  console.error("Scan script crashed:", err);
  process.exit(1);
});
