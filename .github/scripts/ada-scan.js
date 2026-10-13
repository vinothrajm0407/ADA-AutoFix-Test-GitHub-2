// Calls the ADA Tool's existing scan API from CI, waits for the result, and
// fails the workflow (exit code 1) if any accessibility violations are found.
// Only reuses endpoints that already exist for the normal web app — no new
// backend surface needed for this pilot.

const BASE = process.env.ADA_API_BASE;
const EMAIL = process.env.ADA_API_EMAIL;
const PASSWORD = process.env.ADA_API_PASSWORD;
const SITE_URL = process.env.ADA_SITE_URL;

if (!BASE || !EMAIL || !PASSWORD || !SITE_URL) {
  console.error("Missing one of ADA_API_BASE / ADA_API_EMAIL / ADA_API_PASSWORD / ADA_SITE_URL");
  process.exit(1);
}

// The pilot's API base is an ngrok tunnel to a local dev machine — this
// header skips ngrok's free-tier "confirm you trust this link" interstitial,
// which a fresh CI runner (never seen by that tunnel before) could otherwise
// hit on every request. Harmless on a real hosted backend later.
const NGROK_HEADER = { "ngrok-skip-browser-warning": "true" };

async function main() {
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...NGROK_HEADER },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const loginData = await loginRes.json();
  if (!loginData.ok) {
    console.error("Login failed:", loginData.error || loginRes.status);
    process.exit(1);
  }
  const token = loginData.token;
  const authHeaders = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...NGROK_HEADER };

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
    console.error("Scan did not complete in time:", job ? job.status : "no response");
    process.exit(1);
  }

  const violations = job.result?.axeResult?.violations || [];
  const totalElements = violations.reduce((sum, v) => sum + (v.nodes?.length || 1), 0);

  console.log(`\nAccessibility scan result for ${SITE_URL}`);
  console.log(`Rules violated: ${violations.length} | Elements affected: ${totalElements}\n`);
  for (const v of violations) {
    console.log(`  [${v.impact}] ${v.id} — ${v.nodes?.length || 1} element(s)`);
  }

  if (violations.length > 0) {
    console.log(`\n❌ Accessibility scan found ${totalElements} issue(s) across ${violations.length} rule(s).`);
    process.exit(1);
  }
  console.log("\n✅ No accessibility violations found.");
}

main().catch((err) => {
  console.error("Scan script crashed:", err);
  process.exit(1);
});
