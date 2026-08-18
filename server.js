import 'dotenv/config';
import express from 'express';
import nodemailer from 'nodemailer';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const SITE_PASSWORD = process.env.SITE_PASSWORD || '##';

// Middleware Configuration
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

const activeSessions = {};
const transporters = new Map();

/* ==========================================================================
   TRANSPORTER POOLING WITH ANTI-SPAM TRANSPORT OPTIONS
   ========================================================================== */
function getTransporter(email, appPassword) {
  const cleanEmail = email.toLowerCase().trim();
  const cacheKey = `${cleanEmail}_${appPassword}`;

  if (!transporters.has(cacheKey)) {
    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true, // TLS/SSL connection
      auth: { user: cleanEmail, pass: appPassword },
      pool: true,
      maxConnections: 1,
      maxMessages: 20,
      rateDelta: 1000,
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
   HTML TO PLAIN-TEXT CONVERTER
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
  if (password === SITE_PASSWORD) return res.json({ success: true });
  return res.status(401).json({ success: false, message: "Incorrect password" });
});

app.post("/api/verify", async (req, res) => {
  const { email, appPassword } = req.body;
  if (!email || !appPassword) return res.status(400).json({ success: false, message: "Credentials required" });

  try {
    const transporter = getTransporter(email, appPassword);
    await transporter.verify();
    return res.json({ success: true, message: "SMTP verified successfully" });
  } catch (error) {
    return res.status(401).json({ success: false, message: "Authentication failed. Check App Password." });
  }
});

/* ==========================================================================
   SSE STREAM ROUTE FOR HIGH-INBOX DELIVERABILITY
   ========================================================================== */
app.post("/api/send-stream", async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const { email, appPassword, senderName, subject, messageBody, recipients } = req.body;

  if (!email || !appPassword || !Array.isArray(recipients) || recipients.length === 0) {
    res.write(`data: ${JSON.stringify({ success: false, error: "Missing required fields" })}\n\n`);
    res.end();
    return;
  }

  const senderEmail = email.toLowerCase().trim();
  const cleanSenderName = (senderName || "").replace(/"/g, "").trim();
  const domain = senderEmail.split('@')[1] || 'gmail.com';

  activeSessions['global_stop'] = false;

  for (let index = 0; index < recipients.length; index++) {
    if (activeSessions['global_stop']) {
      res.write(`data: ${JSON.stringify({ success: false, error: "Stopped by user" })}\n\n`);
      break;
    }

    const recipient = recipients[index] ? recipients[index].trim() : "";
    if (!recipient) continue;

    res.write(': keep-alive\n\n');

    try {
      const transporter = getTransporter(email, appPassword);
      const spunSubject = parseSpintax(subject);
      let spunBody = parseSpintax(messageBody);
      const isHtml = /<[a-z][\s\S]*>/i.test(spunBody);

      // Clean, low-spam-score footer
      const cleanFooterHtml = `
        <br><br>
        <div style="font-size: 13px; color: #555555; font-family: Arial, sans-serif; line-height: 1.5;">
          <p style="margin: 0;">Best regards,</p>
          <p style="margin: 4px 0 0 0; font-weight: bold; color: #111111;">${cleanSenderName || senderEmail.split('@')[0]}</p>
        </div>
      `;

      const cleanFooterText = `\n\nBest regards,\n${cleanSenderName || senderEmail.split('@')[0]}`;

      // Generating custom RFC 2822 compliant Message-ID
      const uniqueMsgId = `<${Date.now()}.${crypto.randomBytes(8).toString('hex')}@${domain}>`;

      const mailOptions = {
        from: cleanSenderName ? `"${cleanSenderName}" <${senderEmail}>` : senderEmail,
        to: recipient,
        subject: spunSubject,
        messageId: uniqueMsgId,
        headers: {
          'X-Mailer': 'Microsoft Outlook Express 6.00.2900.5512',
          'X-Priority': '3 (Normal)',
          'Importance': 'Normal',
          'List-Unsubscribe': `<mailto:${senderEmail}?subject=unsubscribe>`,
          'Reply-To': senderEmail
        }
      };

      if (isHtml) {
        mailOptions.html = spunBody + cleanFooterHtml;
        mailOptions.text = convertHtmlToText(spunBody) + cleanFooterText;
      } else {
        mailOptions.text = spunBody + cleanFooterText;
      }

      await transporter.sendMail(mailOptions);
      res.write(`data: ${JSON.stringify({ success: true, recipient })}\n\n`);

    } catch (error) {
      console.error(`Error sending to ${recipient}:`, error.message);
      res.write(`data: ${JSON.stringify({ success: false, recipient, error: error.message })}\n\n`);
    }

    // Delay between email sends to lower risk of rate-limiting or flagging
    if (index < recipients.length - 1) {
      const randomDelay = Math.floor(Math.random() * 1500) + 2500;
      await new Promise(resolve => setTimeout(resolve, randomDelay));
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
  res.json({ success: true, message: "Stop process registered" });
});

export default app;
