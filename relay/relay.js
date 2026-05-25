/**
 * Sentinel Stack — alert relay
 * -----------------------------------------------------------------------------
 * Receives Alertmanager webhooks, optionally triages each alert with an LLM
 * (severity + human summary + whether to open a GitHub issue), posts a message
 * to a chat webhook, and optionally opens the issue.
 *
 * Design principle: the AI only ENRICHES. If the LLM call fails, the alert is
 * still delivered to chat (fail-open). The pipeline never depends on the AI.
 *
 * All configuration comes from environment variables — never hardcode secrets.
 */

const express = require("express");

const app = express();
app.use(express.json());

const CFG = {
  openaiKey: process.env.OPENAI_API_KEY || "",
  openaiModel: process.env.OPENAI_MODEL || "gpt-4o-mini",
  openaiTimeoutMs: parseInt(process.env.OPENAI_TIMEOUT_MS || "8000", 10),
  chatWebhook: process.env.CHAT_WEBHOOK_URL || "",
  githubToken: process.env.GITHUB_TOKEN || "",
  githubRepo: process.env.GITHUB_REPO || "",
  enableAiTriage: (process.env.ENABLE_AI_TRIAGE || "true") === "true",
  enableGithubIssues: (process.env.ENABLE_GITHUB_ISSUES || "false") === "true",
  port: parseInt(process.env.PORT || "3000", 10),
};

const FALLBACK_TRIAGE = {
  analysis: "AI triage unavailable — delivering raw alert.",
  create_issue: false,
  priority: "unknown",
};

/** Ask the LLM to triage one alert. Returns FALLBACK_TRIAGE on any error. */
async function triageWithAI(alert) {
  if (!CFG.enableAiTriage || !CFG.openaiKey) return FALLBACK_TRIAGE;

  const prompt = `You are an experienced SRE. Analyze the alert and reply with ONLY valid JSON:
{
  "analysis": "short explanation with likely causes and fixes",
  "create_issue": true | false,
  "priority": "low" | "medium" | "high"
}
Rules:
- Only set create_issue=true for a real problem (outage, high error rate, unavailability).
- Ignore minor/transient noise.

Alert:
- name: ${alert.labels?.alertname}
- severity: ${alert.labels?.severity}
- summary: ${alert.annotations?.summary}
- description: ${alert.annotations?.description}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CFG.openaiTimeoutMs);

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${CFG.openaiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: CFG.openaiModel,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    clearTimeout(timer);

    const data = await res.json();
    let content = data.choices?.[0]?.message?.content || "";
    content = content.replace(/```json/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(content);
    return {
      analysis: parsed.analysis || FALLBACK_TRIAGE.analysis,
      create_issue: Boolean(parsed.create_issue),
      priority: parsed.priority || "unknown",
    };
  } catch (err) {
    console.error("AI triage failed:", err.message);
    return FALLBACK_TRIAGE;
  }
}

/** Open a GitHub issue. Best-effort; logs and continues on failure. */
async function openGithubIssue(title, body) {
  if (!CFG.enableGithubIssues || !CFG.githubToken || !CFG.githubRepo) return null;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${CFG.githubRepo}/issues`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${CFG.githubToken}`,
          Accept: "application/vnd.github+json",
        },
        body: JSON.stringify({ title, body }),
      }
    );
    const data = await res.json();
    console.log("GitHub issue created:", data.html_url || "(no url)");
    return data.html_url || null;
  } catch (err) {
    console.error("GitHub issue failed:", err.message);
    return null;
  }
}

/** Build the chat message text for one alert + its triage. */
function formatMessage(alert, ai, issueUrl) {
  const l = alert.labels || {};
  const a = alert.annotations || {};
  const status = alert.status === "resolved" ? "✅ RESOLVED" : "🚨 FIRING";
  const lines = [
    `${status}  *${l.alertname || "unknown"}*`,
    `severity: ${l.severity || "unknown"} · service: ${l.service || "n/a"} · env: ${l.env || "n/a"}`,
    a.summary ? `\n${a.summary}` : "",
    a.description ? `${a.description}` : "",
    `\n🤖 ${ai.analysis} (priority: ${ai.priority})`,
  ];
  if (issueUrl) lines.push(`🐙 issue: ${issueUrl}`);
  return lines.filter(Boolean).join("\n");
}

/** Post text to the chat webhook. */
async function postToChat(text) {
  if (!CFG.chatWebhook) {
    console.warn("CHAT_WEBHOOK_URL not set — skipping chat post.");
    return;
  }
  try {
    await fetch(CFG.chatWebhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    console.error("Chat post failed:", err.message);
  }
}

app.get("/health", (_req, res) => res.send("ok"));

app.post("/alert", async (req, res) => {
  try {
    const alerts = req.body.alerts || [];
    const messages = [];

    for (const alert of alerts) {
      const ai = await triageWithAI(alert);

      let issueUrl = null;
      if (ai.create_issue) {
        const l = alert.labels || {};
        issueUrl = await openGithubIssue(
          `[ALERT] ${l.alertname || "unknown"} — ${l.service || "service"}`,
          `Auto-filed by Sentinel Stack.\n\n` +
            `- alert: ${l.alertname}\n- severity: ${l.severity}\n` +
            `- service: ${l.service}\n- env: ${l.env}\n\n` +
            `Summary: ${alert.annotations?.summary || ""}\n\n` +
            `Description: ${alert.annotations?.description || ""}\n\n` +
            `AI analysis:\n${ai.analysis}\n`
        );
      }

      messages.push(formatMessage(alert, ai, issueUrl));
    }

    if (messages.length) await postToChat(messages.join("\n\n———\n\n"));
    res.send("ok");
  } catch (err) {
    console.error("Handler error:", err.message);
    res.status(500).send("error");
  }
});

app.listen(CFG.port, () => {
  console.log(`Sentinel relay listening on :${CFG.port}`);
  console.log(`  AI triage: ${CFG.enableAiTriage ? "on" : "off"} · GitHub issues: ${CFG.enableGithubIssues ? "on" : "off"}`);
});
