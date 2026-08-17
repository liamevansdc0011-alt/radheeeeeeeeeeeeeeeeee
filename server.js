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
const PORT = process.env.PORT || 3000;
const SITE_PASSWORD = process.env.SITE_PASSWORD || 'Y##';

const activeSession = { stop: false };
const transporterCache = new Map();

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

/* ==========================================================================
   1. GMAIL SECURE TRANSPORTER (Clean Credentials & Socket Pooling)
   ========================================================================== */
function getTransporter(email, appPassword) {
  const cleanEmail = email.toLowerCase().trim();
  const key = `${cleanEmail}_${appPassword}`;

  if (!transporterCache.has(key)) {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: cleanEmail,
        pass: appPassword
      },
      pool: true,
      maxConnections: 1,
      maxMessages: 50
    });

    transporterCache.set(key, transporter);
  }

  return transporterCache.get(key);
}

/* ==========================================================================
   2. SPINTAX & PERSONALIZATION ENGINE
   ========================================================================== */
function parseSpintax(text) {
  if (!text) return "";
  let spun = text;
  const regex = /{([^{}]+)}/g;
  let iterations = 0;

  while (regex.test(spun) && iterations < 10) {
    spun = spun.replace(regex, (_, choices) => {
      if (!choices.includes('|')) return `{${choices}}`;
      const options = choices.split('|');
      return options[Math.floor(Math.random() * options.length)];
    });
    iterations++;
  }
  return spun;
}

function processRecipient(raw) {
  let email = "";
  let name = "";

  if (typeof raw === 'object' && raw !== null) {
    email = (raw.email || raw.recipient || "").trim();
    name = (raw.name || raw.fullName || "").trim();
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim();
    const match = trimmed.match(/^(?:"?([^"]*)"?\s)?<([^>]+)>$/);
    if (match) {
      name = match[1] ? match[1].trim() : "";
      email = match[2].trim();
    } else {
      email = trimmed;
    }
  }

  if (!name && email.includes('@')) {
    const part = email.split('@')[0];
    name = part.replace(/[0-9_.-]/g, ' ').trim();
  }

  const formattedName = name
    ? name.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')
    : "Valued Client";

  return {
    email: email.toLowerCase(),
    name: formattedName,
    firstName: formattedName.split(' ')[0] || "Client"
  };
}

function generateRefCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function buildBody(template, recipient, refCode) {
  let content = parseSpintax(template);
  content = content.replace(/{Name}/gi, recipient.name);
  content = content.replace(/{FirstName}/gi, recipient.firstName);
  content = content.replace(/{Email}/gi, recipient.email);

  const isHtml = /<[a-z][\s\S]*>/i.test(content);

  const footerHtml = `<br><br><p style="color:#777777;font-size:11px;font-family:sans-serif;margin-top:20px;border-top:1px solid #eeeeee;padding-top:10px;">Ref ID: #${refCode}</p>`;
  const footerText = `\n\n---\nRef ID: #${refCode}`;

  if (isHtml) {
    const plainText = content.replace(/<[^>]*>/g, '').trim();
    return {
      html: content + footerHtml,
      text: plainText + footerText
    };
  }

  return {
    text: content + footerText
  };
}

/* ==========================================================================
   3. ROUTES
   ========================================================================== */
app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === SITE_PASSWORD) return res.json({ success: true });
  return res.status(401).json({ success: false, message: "Unauthorized" });
});

app.post('/api/verify', async (req, res) => {
  const { email, appPassword } = req.body;
  if (!email || !appPassword) return res.status(400).json({ success: false, message: "Missing fields" });

  try {
    const transporter = getTransporter(email, appPassword);
    await transporter.verify();
    return res.json({ success: true, message: "SMTP Connected" });
  } catch (error) {
    return res.status(401).json({ success: false, message: error.message });
  }
});

/* ==========================================================================
   4. STREAM ENGINE (Dynamic Human Delays: 2.1s - 4.8s)
   ========================================================================== */
app.post('/api/send-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  const { email, appPassword, senderName, subject, messageBody, recipients } = req.body;

  if (!email || !appPassword || !Array.isArray(recipients) || recipients.length === 0) {
    res.write(`data: ${JSON.stringify({ success: false, error: "Invalid Request" })}\n\n`);
    res.end();
    return;
  }

  const cleanEmail = email.toLowerCase().trim();
  const cleanSender = (senderName || "").replace(/"/g, "").trim();
  activeSession.stop = false;

  const transporter = getTransporter(email, appPassword);

  for (let i = 0; i < recipients.length; i++) {
    if (activeSession.stop) {
      res.write(`data: ${JSON.stringify({ success: false, error: "Stopped" })}\n\n`);
      break;
    }

    const recipient = processRecipient(recipients[i]);
    if (!recipient.email) continue;

    try {
      const refCode = generateRefCode();
      const spunSubject = parseSpintax(subject);
      const bodies = buildBody(messageBody, recipient, refCode);

      const mailOptions = {
        from: cleanSender ? `"${cleanSender}" <${cleanEmail}>` : cleanEmail,
        to: recipient.name !== "Valued Client" ? `"${recipient.name}" <${recipient.email}>` : recipient.email,
        subject: spunSubject,
        text: bodies.text,
        html: bodies.html || undefined
      };

      await transporter.sendMail(mailOptions);
      res.write(`data: ${JSON.stringify({ success: true, recipient: recipient.email, ref: refCode })}\n\n`);

    } catch (err) {
      res.write(`data: ${JSON.stringify({ success: false, recipient: recipient.email, error: err.message })}\n\n`);
    }

    // Dynamic Safe Delay (2.1 seconds to 4.8 seconds per email)
    if (i < recipients.length - 1) {
      const safeDelay = Math.floor(2100 + Math.random() * 2700);
      await new Promise(resolve => setTimeout(resolve, safeDelay));
    }
  }

  res.write("data: [DONE]\n\n");
  res.end();
});

app.post('/api/stop', (req, res) => {
  activeSession.stop = true;
  res.json({ success: true, message: "Stopping send process..." });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

export default app;
