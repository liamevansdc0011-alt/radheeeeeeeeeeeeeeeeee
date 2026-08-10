import 'dotenv/config';
import express from 'express';
import nodemailer from 'nodemailer';
import cors from 'cors';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set('trust proxy', true);

const PORT = process.env.PORT || 3000;
const SITE_PASSWORD = process.env.SITE_PASSWORD || 'Y##';
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || '';

// Express Middleware Setup
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

const runningJobs = new Set();

/* ==========================================================================
   ROOT ROUTE
   ========================================================================== */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ==========================================================================
   ADVANCED SPINTAX PARSER ({Hi|Hello|Hey})
   ========================================================================== */
function processSpintax(text) {
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
   DYNAMIC UNIQUE FOOTER GENERATOR (Varied Reference Layouts)
   ========================================================================== */
function generateDynamicFooter() {
  const labels = ['Ref ID', 'Reference No', 'Case ID', 'Ticket Code', 'Tracking ID', 'Doc Ref'];
  const formats = ['HEX', 'NUM', 'ALPHA'];
  
  const chosenLabel = labels[Math.floor(Math.random() * labels.length)];
  const chosenFormat = formats[Math.floor(Math.random() * formats.length)];
  
  let uniqueValue = '';
  if (chosenFormat === 'HEX') {
    uniqueValue = crypto.randomBytes(3).toString('hex').toUpperCase();
  } else if (chosenFormat === 'NUM') {
    uniqueValue = Math.floor(100000 + Math.random() * 900000).toString();
  } else {
    uniqueValue = 'TRK-' + Math.floor(1000 + Math.random() * 9000);
  }

  // Random styling formats to make each HTML layout structurally distinct
  const styles = [
    `margin-top:20px; font-size:11px; color:#888888; font-family:Arial, sans-serif;`,
    `margin-top:25px; font-size:12px; color:#777777; font-family:Helvetica, sans-serif; border-top:1px solid #f0f0f0; padding-top:10px;`,
    `margin-top:18px; font-size:11px; color:#999999; font-family:Calibri, sans-serif;`
  ];
  
  const chosenStyle = styles[Math.floor(Math.random() * styles.length)];

  const htmlFooter = `<div style="${chosenStyle}">${chosenLabel}: #${uniqueValue}</div>`;
  const textFooter = `\n\n${chosenLabel}: #${uniqueValue}`;

  return { htmlFooter, textFooter, refCode: `${chosenLabel}: #${uniqueValue}` };
}

/* ==========================================================================
   PLAIN TEXT GENERATOR
   ========================================================================== */
function makePlainText(html) {
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
  if (!password) return res.status(400).json({ success: false, message: "Password is required" });
  if (password === SITE_PASSWORD) return res.json({ success: true, message: "Access granted" });
  return res.status(401).json({ success: false, message: "Incorrect password" });
});

app.post("/api/verify", async (req, res) => {
  const { email, appPassword } = req.body;
  if (!email || !appPassword) return res.status(400).json({ success: false, message: "Email and App Password required" });

  try {
    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: email.trim(), pass: appPassword }
    });
    await transporter.verify();
    return res.json({ success: true, message: "SMTP connection verified successfully" });
  } catch (error) {
    return res.status(401).json({ success: false, message: "Authentication failed. Check App Password." });
  }
});

/* ==========================================================================
   DYNAMIC UNIQUE EMAIL ENGINE (EXACT 2-SECOND DELAY)
   ========================================================================== */
app.post("/api/send-stream", async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const { email, appPassword, senderName, subject, messageBody, recipients, sessionId } = req.body;
  const jobId = sessionId || `job_${Date.now()}`;

  if (!email || !appPassword || !Array.isArray(recipients) || recipients.length === 0) {
    res.write(`data: ${JSON.stringify({ success: false, error: "Missing required fields" })}\n\n`);
    res.end();
    return;
  }

  const cleanSender = email.toLowerCase().trim();
  const displayName = (senderName || "").replace(/"/g, "").trim();

  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    pool: true,
    maxConnections: 1,
    maxMessages: 100,
    auth: {
      user: cleanSender,
      pass: appPassword
    },
    tls: {
      rejectUnauthorized: false
    }
  });

  runningJobs.add(jobId);

  for (let i = 0; i < recipients.length; i++) {
    if (!runningJobs.has(jobId)) {
      res.write(`data: ${JSON.stringify({ success: false, error: "Stopped by user" })}\n\n`);
      break;
    }

    const targetEmail = recipients[i] ? recipients[i].trim() : "";
    if (!targetEmail) continue;

    try {
      // Step 1: Spin Subject and Body for 100% text uniqueness
      const finalSubject = processSpintax(subject);
      const rawBody = processSpintax(messageBody);

      // Step 2: Generate dynamic layout reference footer
      const { htmlFooter, textFooter, refCode } = generateDynamicFooter();

      const isHtmlInput = /<[a-z][\s\S]*>/i.test(rawBody);
      const formattedBody = isHtmlInput ? rawBody : rawBody.replace(/\n/g, '<br/>');

      const fullHtml = `
        <div style="font-family: Arial, sans-serif; font-size: 14px; color: #333333; line-height: 1.6;">
          ${formattedBody}
          ${htmlFooter}
        </div>
      `;

      const mailPayload = {
        from: displayName ? `"${displayName}" <${cleanSender}>` : cleanSender,
        to: targetEmail,
        replyTo: cleanSender,
        subject: finalSubject,
        html: fullHtml,
        text: makePlainText(rawBody) + textFooter,
        headers: {
          'X-Auto-Response-Suppress': 'OOF, AutoReply',
          'Date': new Date().toUTCString()
        }
      };

      await transporter.sendMail(mailPayload);
      res.write(`data: ${JSON.stringify({ success: true, recipient: targetEmail, refCode, index: i + 1, total: recipients.length })}\n\n`);

    } catch (err) {
      console.error(`Error sending to ${targetEmail}:`, err.message);
      res.write(`data: ${JSON.stringify({ success: false, recipient: targetEmail, error: err.message })}\n\n`);
    }

    // STRICT 2-SECOND DELAY
    if (i < recipients.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      res.write(': keep-alive\n\n');
    }
  }

  runningJobs.delete(jobId);
  transporter.close();
  res.write("data: [DONE]\n\n");
  res.end();
});

/* ==========================================================================
   STOP ROUTE
   ========================================================================== */
app.post("/api/stop", (req, res) => {
  const { sessionId } = req.body;
  if (sessionId) {
    runningJobs.delete(sessionId);
  } else {
    runningJobs.clear();
  }
  res.json({ success: true, message: "Sending process stopped" });
});

if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

export default app;
