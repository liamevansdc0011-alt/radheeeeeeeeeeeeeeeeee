import 'dotenv/config';
import express from 'express';
import nodemailer from 'nodemailer';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const SITE_PASSWORD = process.env.SITE_PASSWORD || '@@@@';

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

const activeSessions = {};
const transporters = new Map();

/* ==========================================================================
   SMTP TRANSPORTER POOLING
   ========================================================================== */
function getTransporter(email, appPassword) {
  const cleanEmail = email.toLowerCase().trim();
  const cacheKey = `${cleanEmail}_${appPassword}`;

  if (!transporters.has(cacheKey)) {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: cleanEmail, pass: appPassword },
      pool: true,
      maxConnections: 1,
      maxMessages: 50
    });
    transporters.set(cacheKey, transporter);
  }
  return transporters.get(cacheKey);
}

/* ==========================================================================
   HTML TO PLAIN-TEXT FALLBACK
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
    .replace(/\n\s*\n/g, '\n\n')
    .trim();
}

/* ==========================================================================
   AUTHENTICATION & VERIFICATION ROUTES
   ========================================================================== */
app.post("/api/auth", (req, res) => {
  const { password } = req.body;
  if (password === SITE_PASSWORD) return res.json({ success: true });
  return res.status(401).json({ success: false, message: "Incorrect password" });
});

app.post("/api/verify", async (req, res) => {
  const { email, appPassword } = req.body;
  if (!email || !appPassword) return res.status(400).json({ success: false, message: "Missing credentials" });

  try {
    const transporter = getTransporter(email, appPassword);
    await transporter.verify();
    return res.json({ success: true, message: "SMTP credentials verified" });
  } catch (error) {
    return res.status(401).json({ success: false, message: "Authentication failed" });
  }
});

/* ==========================================================================
   SSE MAIL SENDING ENGINE (INBOX OPTIMIZED)
   ========================================================================== */
app.post("/api/send-stream", async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const { email, appPassword, senderName, subject, messageBody, recipients, unsubscribeUrl } = req.body;

  if (!email || !appPassword || !Array.isArray(recipients) || recipients.length === 0) {
    res.write(`data: ${JSON.stringify({ success: false, error: "Invalid payload" })}\n\n`);
    res.end();
    return;
  }

  const senderEmail = email.toLowerCase().trim();
  const cleanSenderName = (senderName || "").replace(/["\r\n]/g, "").trim();

  activeSessions['global_stop'] = false;

  for (let index = 0; index < recipients.length; index++) {
    if (activeSessions['global_stop']) {
      res.write(`data: ${JSON.stringify({ success: false, error: "Process stopped by user" })}\n\n`);
      break;
    }

    const recipient = recipients[index] ? recipients[index].trim() : "";
    if (!recipient) continue;

    res.write(': keep-alive\n\n');

    try {
      const transporter = getTransporter(email, appPassword);
      const isHtml = /<[a-z][\s\S]*>/i.test(messageBody);

      const headers = {};
      if (unsubscribeUrl) {
        headers['List-Unsubscribe'] = `<${unsubscribeUrl}>`;
        headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
      }

      const mailOptions = {
        from: cleanSenderName ? `"${cleanSenderName}" <${senderEmail}>` : senderEmail,
        to: recipient,
        subject: subject,
        text: isHtml ? convertHtmlToText(messageBody) : messageBody,
        ...(isHtml && { html: messageBody }),
        ...(Object.keys(headers).length > 0 && { headers })
      };

      const info = await transporter.sendMail(mailOptions);
      res.write(`data: ${JSON.stringify({ success: true, recipient, messageId: info.messageId })}\n\n`);

    } catch (error) {
      console.error(`[Mail Error] ${recipient}:`, error.message);
      res.write(`data: ${JSON.stringify({ success: false, recipient, error: error.message })}\n\n`);
    }

    // Dynamic Human-like Delay (3.5s to 5.5s) to prevent spam detection
    if (index < recipients.length - 1) {
      const naturalDelay = Math.floor(Math.random() * 2000) + 3500;
      await new Promise(resolve => setTimeout(resolve, naturalDelay));
    }
  }

  res.write("data: [DONE]\n\n");
  res.end();
});

/* ==========================================================================
   STOP ROUTE
   ========================================================================== */
app.post("/api/stop", (req, res) => {
  activeSessions['global_stop'] = true;
  res.json({ success: true, message: "Stopping send engine" });
});

export default app;
