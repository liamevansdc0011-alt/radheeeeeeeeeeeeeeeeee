import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.set('trust proxy', true);

const SITE_PASSWORD = process.env.SITE_PASSWORD || 'Y##';
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || ''; // Resend.com se milegi

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

const activeSessions = new Map();

/* ==========================================================================
   ROOT ROUTE
   ========================================================================== */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ==========================================================================
   SPINTAX PARSER ({Hi|Hello|Hey})
   ========================================================================== */
function parseSpintax(text) {
  if (!text) return "";
  let spun = text;
  const regex = /{([^{}]+)}/g;
  let iterations = 0;
  while (regex.test(spun) && iterations < 10) {
    spun = spun.replace(regex, (_, choices) => {
      const options = choices.split('|');
      return options[Math.floor(Math.random() * options.length)];
    });
    iterations++;
  }
  return spun;
}

/* ==========================================================================
   AUTHENTICATION ROUTES
   ========================================================================== */
app.post("/api/auth", (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ success: false, message: "Password required" });
  if (password === SITE_PASSWORD) return res.json({ success: true, message: "Access granted" });
  return res.status(401).json({ success: false, message: "Incorrect password" });
});

/* ==========================================================================
   RESEND API SSE STREAM ROUTE (INBOX GUARANTEED)
   ========================================================================== */
app.post("/api/send-stream", async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const { senderEmail, senderName, subject, messageBody, recipients, sessionId, apiKey } = req.body;

  const currentSession = sessionId || 'session_' + Date.now();
  const activeApiKey = apiKey || RESEND_API_KEY;

  if (!activeApiKey) {
    res.write(`data: ${JSON.stringify({ success: false, error: "Resend API Key is missing!" })}\n\n`);
    res.end();
    return;
  }

  if (!Array.isArray(recipients) || recipients.length === 0) {
    res.write(`data: ${JSON.stringify({ success: false, error: "Recipients list is empty" })}\n\n`);
    res.end();
    return;
  }

  activeSessions.set(currentSession, true);

  for (let index = 0; index < recipients.length; index++) {
    if (activeSessions.get(currentSession) === false) {
      res.write(`data: ${JSON.stringify({ success: false, error: "Process stopped by user" })}\n\n`);
      break;
    }

    const recipient = recipients[index] ? recipients[index].trim() : "";
    if (!recipient) continue;

    try {
      const spunSubject = parseSpintax(subject);
      const spunBody = parseSpintax(messageBody);
      const isHtml = /<[a-z][\s\S]*>/i.test(spunBody);

      // Resend API Fetch Call
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${activeApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: senderName ? `${senderName} <onboarding@resend.dev>` : 'onboarding@resend.dev',
          to: [recipient],
          subject: spunSubject,
          [isHtml ? 'html' : 'text']: spunBody
        })
      });

      const data = await response.json();

      if (response.ok) {
        res.write(`data: ${JSON.stringify({ success: true, recipient, index: index + 1, total: recipients.length })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ success: false, recipient, error: data.message || "Sending failed" })}\n\n`);
      }

    } catch (error) {
      console.error(`Error sending to ${recipient}:`, error.message);
      res.write(`data: ${JSON.stringify({ success: false, recipient, error: error.message })}\n\n`);
    }

    // Smooth 3 second delay
    if (index < recipients.length - 1) {
      await new Promise(r => setTimeout(r, 3000));
      res.write(': keep-alive\n\n');
    }
  }

  activeSessions.delete(currentSession);
  res.write("data: [DONE]\n\n");
  res.end();
});

/* ==========================================================================
   STOP ROUTE
   ========================================================================== */
app.post("/api/stop", (req, res) => {
  const { sessionId } = req.body;
  if (sessionId) activeSessions.set(sessionId, false);
  res.json({ success: true, message: "Stop signal sent" });
});

export default app;
