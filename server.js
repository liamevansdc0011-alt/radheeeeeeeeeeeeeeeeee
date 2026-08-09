import 'dotenv/config';
import express from 'express';
import nodemailer from 'nodemailer';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.set('trust proxy', true);

const SITE_PASSWORD = process.env.SITE_PASSWORD || 'Y##';
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || '';

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

const activeSessions = new Map();
const transporters = new Map();

/* ==========================================================================
   ROOT ROUTE
   ========================================================================== */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ==========================================================================
   HELPER: CLOUDFLARE TURNSTILE VERIFICATION
   ========================================================================== */
async function verifyTurnstile(token, ip) {
  if (!TURNSTILE_SECRET_KEY) return true;
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret: TURNSTILE_SECRET_KEY,
        response: token,
        remoteip: ip || ''
      })
    });
    const data = await response.json();
    return data.success;
  } catch (error) {
    console.error("Turnstile Error:", error);
    return false;
  }
}

/* ==========================================================================
   INBOX OPTIMIZED TRANSPORTER (POOLED FOR INBOX DELIVERY)
   ========================================================================== */
function getInboxTransporter(email, appPassword) {
  const cleanEmail = email.toLowerCase().trim();
  const cacheKey = `${cleanEmail}_${appPassword}`;

  if (!transporters.has(cacheKey)) {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: cleanEmail, pass: appPassword },
      pool: true,             // Connection reuse prevents spam flagging
      maxConnections: 1,      // Single line connection for authentic behavior
      maxMessages: 100,
      rateDelta: 3000,        // 3 seconds rate delta
      rateLimit: 1
    });
    transporters.set(cacheKey, transporter);
  }
  return transporters.get(cacheKey);
}

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
   CLEAN TEXT FALLBACK FOR MIME SCORE
   ========================================================================== */
function convertHtmlToText(html) {
  if (!html) return "";
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\n\s*\n/g, '\n\n')
    .trim();
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

app.post("/api/verify", async (req, res) => {
  const { email, appPassword, cfToken } = req.body;
  if (!email || !appPassword) return res.status(400).json({ success: false, message: "Email & App Password required" });

  if (cfToken && TURNSTILE_SECRET_KEY) {
    const isValid = await verifyTurnstile(cfToken, req.ip);
    if (!isValid) return res.status(400).json({ success: false, message: "Security check failed." });
  }

  try {
    const transporter = getInboxTransporter(email, appPassword);
    await transporter.verify();
    return res.json({ success: true, message: "SMTP connection verified" });
  } catch (error) {
    return res.status(401).json({ success: false, message: "Auth failed. Check App Password." });
  }
});

/* ==========================================================================
   3-SECOND INTERVAL SSE STREAM ROUTE
   ========================================================================== */
app.post("/api/send-stream", async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const { email, appPassword, senderName, subject, messageBody, recipients, cfToken, sessionId } = req.body;

  const currentSession = sessionId || 'session_' + Date.now();

  if (!email || !appPassword || !Array.isArray(recipients) || recipients.length === 0) {
    res.write(`data: ${JSON.stringify({ success: false, error: "Missing required fields" })}\n\n`);
    res.end();
    return;
  }

  if (cfToken && TURNSTILE_SECRET_KEY) {
    const isValid = await verifyTurnstile(cfToken, req.ip);
    if (!isValid) {
      res.write(`data: ${JSON.stringify({ success: false, error: "Turnstile check failed" })}\n\n`);
      res.end();
      return;
    }
  }

  const senderEmail = email.toLowerCase().trim();
  const cleanSenderName = (senderName || "").replace(/"/g, "").trim();

  activeSessions.set(currentSession, true);
  const transporter = getInboxTransporter(email, appPassword);

  for (let index = 0; index < recipients.length; index++) {
    // Check stop flag
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

      // Inbox Deliverability Headers Structure
      const mailOptions = {
        from: cleanSenderName ? `"${cleanSenderName}" <${senderEmail}>` : senderEmail,
        to: recipient,
        replyTo: senderEmail,
        subject: spunSubject,
        date: new Date(),
        text: isHtml ? convertHtmlToText(spunBody) : spunBody,
        ...(isHtml && { html: spunBody })
      };

      await transporter.sendMail(mailOptions);
      res.write(`data: ${JSON.stringify({ success: true, recipient, index: index + 1, total: recipients.length })}\n\n`);

    } catch (error) {
      console.error(`Error sending to ${recipient}:`, error.message);
      res.write(`data: ${JSON.stringify({ success: false, recipient, error: error.message })}\n\n`);
    }

    // STRICT 3-SECOND DELAY WITH ORGANIC MICRO-VARIATION (3.0s - 3.4s)
    if (index < recipients.length - 1) {
      const delayMs = 3000 + Math.floor(Math.random() * 400); // ~3 seconds
      let elapsed = 0;
      const step = 1000;

      while (elapsed < delayMs) {
        if (activeSessions.get(currentSession) === false) break;
        await new Promise(r => setTimeout(r, step));
        elapsed += step;
        res.write(': keep-alive\n\n');
      }
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
  if (sessionId) {
    activeSessions.set(sessionId, false);
  } else {
    for (let [key] of activeSessions) {
      activeSessions.set(key, false);
    }
  }
  res.json({ success: true, message: "Stop signal sent" });
});

export default app;
